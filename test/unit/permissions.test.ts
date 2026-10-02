import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import type { RunwayConfig } from '../../src/config.ts'
import { deepFreeze } from '../../src/index.ts'
import { gate, REVIEW_INPUT_LIMIT } from '../../src/permissions/gate.ts'
import { GrantStore } from '../../src/permissions/grants.ts'
import { normalize } from '../../src/permissions/operation.ts'
import type { ToolIdentity } from '../../src/permissions/operation.ts'
import { literalPattern, matchHost, matchPath, matchText, parseRules, ruleMatches, strongestMatch } from '../../src/permissions/rules.ts'
import { analyzeShell } from '../../src/permissions/shell.ts'
import { saveScopes } from '../../src/permissions/suggest.ts'
import { buildPolicy } from '../../src/policy.ts'
import { Runtime } from '../../src/runtime.ts'
import { jevAnswers } from '../support/harness.ts'

const base = join(import.meta.dirname, '..', '..', '.e2e')
mkdirSync(base, { recursive: true })
const root = realpathSync(mkdtempSync(join(base, 'perm-')))
const project = join(root, 'app')
mkdirSync(project)
writeFileSync(join(project, 'a.ts'), 'x')
after(() => rmSync(root, { recursive: true, force: true }))
const agentDir = join(homedir(), '.pi', 'agent')
const policy = buildPolicy(project, DEFAULT_CONFIG, agentDir)

const id = {
  builtin: (name: string): ToolIdentity => ({ kind: 'pi-builtin', name }),
  runway: { kind: 'runway' } as ToolIdentity,
  mcp: { kind: 'pi-extension', name: 'mcp' } as ToolIdentity,
  other: { kind: 'extension', path: '/somewhere/else.ts' } as ToolIdentity,
}

function op(tool: string, input: Record<string, unknown>, identity: ToolIdentity, cwd = project) {
  return normalize({ tool, input, cwd, toolCallId: `c${Math.random()}`, meta: { identity, source: 'extension' } })
}

test('shell: compound commands split, quotes respected, opaque constructs flagged', () => {
  const a = analyzeShell(`npm test && git push --force origin main; echo "a && b" | wc -l`)
  assert.deepEqual(a.segments, ['npm test', 'git push --force origin main', 'echo "a && b"', 'wc -l'])
  assert.equal(a.opaque, false)
  assert.equal(analyzeShell('echo $(cat secret)').opaque, true)
  assert.equal(analyzeShell('bash -c "rm -rf x"').opaque, true)
  assert.equal(analyzeShell('FOO=1 eval "$X"').opaque, true)
  assert.equal(analyzeShell('find . -name x -delete').opaque, true)
  assert.equal(analyzeShell("echo 'unterminated").opaque, true)
  assert.deepEqual(analyzeShell('curl -s https://api.example.com/x && git clone git@github.com:o/r.git').hosts.sort(), ['api.example.com', 'github.com'])
  assert.equal(analyzeShell('ls > out.txt').writesFiles, true)
  assert.equal(analyzeShell('ls 2>&1 >/dev/null').writesFiles, false)
})

test('globs: commands, paths (project-relative, ~, dirs), hosts', () => {
  assert.ok(matchText('git push --force*', 'git push --force origin main'))
  assert.ok(!matchText('git push --force*', 'git push origin main'))
  assert.ok(matchText('npm test', '  npm test '))
  assert.ok(matchText('literal \\*', 'literal *'))
  assert.ok(!matchText('literal \\*', 'literal x'))
  assert.ok(matchPath('src/**', join(project, 'src', 'a', 'b.ts'), project))
  assert.ok(!matchPath('src/*', join(project, 'src', 'a', 'b.ts'), project))
  assert.ok(matchPath('~/notes', join(homedir(), 'notes', 'x.md'), project), 'a folder without wildcards covers its contents')
  assert.ok(matchHost('*.example.com', 'api.example.com'))
  assert.ok(!matchHost('*.example.com', 'example.org'))
})

test('identity, not name: a non-builtin "read" is just another tool', () => {
  assert.equal(op('read', { path: 'a.ts' }, id.builtin('read')).kind, 'read')
  const impostor = op('read', { path: 'a.ts' }, id.other)
  assert.equal(impostor.kind, 'tool')
  assert.equal(op('bash', { command: 'ls' }, id.runway).kind, 'shell')
  assert.equal(op('bash', { command: 'ls' }, id.other).kind, 'tool', "someone else's bash is not Runway's sandboxed bash")
  assert.equal(op('tool_search', { query: 'x' }, id.other).kind, 'tool', 'a coordination name from an unknown source is not coordination')
  assert.equal(op('tool_search', { query: 'x' }, { kind: 'pi-extension', name: 'tool-search' }).kind, 'meta')
  const m = op('mcp__github__create_issue', { title: 't', url: 'https://github.com/o/r' }, id.mcp)
  assert.equal(m.kind, 'mcp')
  assert.deepEqual(m.mcp, { server: 'github', tool: 'create_issue' })
  assert.deepEqual(m.hosts, ['github.com'])
  assert.equal(op('mcp__github__create_issue', {}, id.other).kind, 'tool', 'an mcp__ name from elsewhere is not an MCP call')
})

test('bash execution scope: sandboxed, scoped access, unsandboxed', () => {
  assert.equal(op('bash', { command: 'make' }, id.runway).execution, 'sandboxed')
  const scoped = op('bash', { command: 'cp x ../y', access: { write: ['../y'], hosts: ['API.example.com'] } }, id.runway)
  assert.equal(scoped.execution, 'sandboxed-with-access')
  assert.deepEqual(scoped.access?.hosts, ['api.example.com'])
  assert.equal(op('bash', { command: 'git push', escalate: true }, id.runway).execution, 'unsandboxed')
  assert.notEqual(op('bash', { command: 'git push', escalate: true }, id.runway).key, op('bash', { command: 'git push' }, id.runway).key, 'a sandboxed approval never covers the unsandboxed form')
})

test('rules: deny matches any part of a compound command; allow needs every part; project allows are dropped', () => {
  const problems: string[] = []
  const rules = parseRules([
    { action: 'deny', command: 'git push --force*', reason: 'never force-push' },
    { action: 'allow', command: 'npm test*' },
  ], 'personal', 'test', problems)
  assert.deepEqual(problems, [])
  const ctx = { policy }
  const compound = op('bash', { command: 'npm test && git push --force' }, id.runway)
  assert.ok(ruleMatches(rules[0]!, compound, ctx))
  assert.ok(!ruleMatches(rules[1]!, compound, ctx), 'allow npm test* does not cover the push')
  assert.ok(ruleMatches(rules[1]!, op('bash', { command: 'npm test -- --watch=false' }, id.runway), ctx))
  assert.ok(!ruleMatches(rules[1]!, op('bash', { command: 'npm test', escalate: true }, id.runway), ctx), 'an allow rule never turns the sandbox off by itself')
  const projectProblems: string[] = []
  const project = parseRules([{ action: 'allow', tool: '*' }, { action: 'ask', tool: 'mcp__*' }], 'project', 'p', projectProblems)
  assert.equal(project.length, 1)
  assert.match(projectProblems.join(), /only add "deny" or "ask"/)
  assert.ok(parseRules([{ action: 'allow' }], 'personal', 'x', problems).length === 0 && problems.some(p => /at least one of/.test(p)))
})

test('grants: session-scoped, inherited by children only, tool grants never cover unsandboxed', () => {
  const g = new GrantStore()
  const npm = op('bash', { command: 'npm test' }, id.runway)
  g.add('parent', { scope: 'operation', key: npm.key, label: 'npm test', tool: 'bash', by: 'person' })
  g.setParent('child', 'parent')
  assert.ok(g.findPersonGrant('parent', npm, 'operation'))
  assert.ok(g.findPersonGrant('child', npm, 'operation'), 'children see parent grants')
  assert.ok(!g.findPersonGrant('other', npm, 'operation'), 'unrelated sessions do not')
  g.add('child', { scope: 'tool', key: 'bash', label: 'all bash', tool: 'bash', by: 'person' })
  assert.ok(!g.findPersonGrant('parent', op('bash', { command: 'make' }, id.runway), 'tool'), "a child's grant never flows up")
  assert.ok(g.findPersonGrant('child', op('bash', { command: 'make' }, id.runway), 'tool'))
  assert.ok(!g.findPersonGrant('child', op('bash', { command: 'make', escalate: true }, id.runway), 'tool'))
  g.setParent('parent', 'child')
  assert.equal(g.parentOf('parent'), undefined, 'cycles are refused')
  // Allowing the whole tool is not permission to widen the fence.
  assert.ok(!g.findPersonGrant('child', op('bash', { command: 'make', access: { write: ['/elsewhere'] } }, id.runway), 'tool'))
  assert.ok(!g.findPersonGrant('child', op('bash', { command: 'make', access: { hosts: ['api.example.com'] } }, id.runway), 'tool'))
})

test('operation keys: any change to input, folder, implementation or access is a different operation', () => {
  const k = (tool: string, input: Record<string, unknown>, identity: ToolIdentity, cwd?: string) => op(tool, input, identity, cwd).key
  assert.notEqual(k('write', { path: 'a.ts', content: 'one' }, id.builtin('write')), k('write', { path: 'a.ts', content: 'two' }, id.builtin('write')))
  assert.notEqual(k('edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }, id.builtin('edit')), k('edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'c' }] }, id.builtin('edit')))
  assert.notEqual(k('bash', { command: 'make' }, id.runway), k('bash', { command: 'make' }, id.runway, root))
  assert.notEqual(k('lint', { x: 1 }, id.other), k('lint', { x: 1 }, { kind: 'extension', path: '/another/impl.ts' }))
  assert.notEqual(k('bash', { command: 'make|w:/x' }, id.runway), k('bash', { command: 'make', access: { write: ['/x'] } }, id.runway))
  const net = op('bash', { command: 'curl https://api.example.com:8443/x' }, id.runway)
  assert.deepEqual(net.endpoints, [{ host: 'api.example.com', port: 8443 }])
})

test('literal patterns round-trip: a saved exact value matches itself and nothing else', () => {
  for (const text of ['foo?', 'foo*bar', '*', 'a[b]c', 'back\\slash', 'x\\*y', 'npm run "a b"', '?*?']) {
    const pattern = literalPattern(text)
    assert.ok(matchText(pattern, text), `${text} matches its own literal`)
    for (const other of ['fo', 'fooobar', 'anything', `${text}x`, text.replace(/\*/g, 'zz')]) {
      if (other !== text) assert.ok(!matchText(pattern, other), `${JSON.stringify(text)} literal does not match ${JSON.stringify(other)}`)
    }
  }
})

test('path rules: directory boundaries, canonical aliases, escaped literals', () => {
  assert.ok(matchPath('/work/**/secret', '/work/a/secret', project))
  assert.ok(matchPath('/work/**/secret', '/work/secret', project))
  assert.ok(!matchPath('/work/**/secret', '/work/notsecret', project))
  assert.ok(!matchPath('/work/**/secret', '/work/mysecret', project))
  assert.ok(!matchPath('src/**', join(project, 'srcx', 'a.ts'), project))
  if (process.platform === 'darwin') {
    assert.ok(matchPath('/tmp/**', '/private/tmp/x/y', project), '/tmp is /private/tmp')
    assert.ok(matchPath('/tmp/example', '/private/tmp/example', project), 'missing leaves canonicalize through their parent')
  }
  assert.ok(matchPath(literalPattern('/w/a*b'), '/w/a*b', project))
  assert.ok(!matchPath(literalPattern('/w/a*b'), '/w/axxb', project))
})

test('rules: allow never covers parts it does not name; deny sees through wrappers and substitutions', () => {
  const ctx = { policy }
  const [allowGit] = rules([{ action: 'allow', command: 'git*' }])
  for (const c of ['git status && curl example.org', 'git status || rm -rf important', 'git status $(curl x)', 'git log `rm x`']) {
    assert.ok(!ruleMatches(allowGit!, op('bash', { command: c }, id.runway), ctx), c)
  }
  const [deny] = rules([{ action: 'deny', command: 'git push*' }])
  for (const c of ['git status $(git push --force)', 'git status `git push --force`', 'env git push --force', 'sudo -u me git push', "bash -c 'git push origin'", 'timeout 9 git push']) {
    assert.ok(ruleMatches(deny!, op('bash', { command: c }, id.runway), ctx), c)
  }
  // Exact arguments mean exactly those arguments.
  const [exact] = rules([{ action: 'allow', tool: 'mcp__gh__issue', inputExact: { n: 1 } }])
  assert.ok(ruleMatches(exact!, op('mcp__gh__issue', { n: 1 }, id.mcp), ctx))
  assert.ok(!ruleMatches(exact!, op('mcp__gh__issue', { n: 1, force: true }, id.mcp), ctx))
  const [empty] = rules([{ action: 'allow', tool: 'lint', inputExact: {} }])
  assert.ok(!ruleMatches(empty!, op('lint', { fix: true }, id.other), ctx), 'empty exact input is not "any input"')
  // A plain command rule never approves extra access; one that names it does, for exactly that.
  const [make] = rules([{ action: 'allow', command: 'make' }])
  assert.ok(!ruleMatches(make!, op('bash', { command: 'make', access: { write: ['/elsewhere'] } }, id.runway), ctx))
  const [makeAccess] = rules([{ action: 'allow', command: 'make', access: { write: ['/elsewhere'] } }])
  assert.ok(ruleMatches(makeAccess!, op('bash', { command: 'make', access: { write: ['/elsewhere'] } }, id.runway), ctx))
  assert.ok(!ruleMatches(makeAccess!, op('bash', { command: 'make', access: { write: ['/elsewhere', '/etc'] } }, id.runway), ctx))
})

test('gate: a compound command is allowed when each part has its own allow rule, and only then', async () => {
  const h = harness()
  const config = { permissions: rules([{ action: 'allow', command: 'npm test' }, { action: 'allow', command: 'npm run lint*' }]) }
  assert.equal((await h.run(op('bash', { command: 'npm test && npm run lint -- --fix' }, id.runway), { config })).by, 'rule')
  assert.equal((await h.run(op('bash', { command: 'npm test && curl x.example' }, id.runway), { config, jev: 'allow' })).by, 'reviewer')
  assert.equal((await h.run(op('bash', { command: 'npm test && $(npm run lint)' }, id.runway), { config, jev: 'allow' })).by, 'reviewer', 'not for commands it cannot read in full')
})

test('approved arguments are frozen all the way down, even under a frozen root', () => {
  const inner = { value: 'approved' }
  const args = Object.freeze({ nested: inner, list: [{ x: 1 }] })
  const cyclic: Record<string, unknown> = { a: 1 }
  cyclic.self = cyclic
  deepFreeze(args)
  deepFreeze(cyclic)
  assert.ok(Object.isFrozen(inner) && Object.isFrozen(args.list[0]))
  assert.throws(() => {
    'use strict'
    ;(inner as { value: string }).value = 'changed'
  })
  assert.ok(Object.isFrozen(cyclic))
})

test('save scopes: narrowest first, exactly the shown access, broad ones marked', () => {
  const scopes = saveScopes(op('bash', { command: 'git push origin main', escalate: true }, id.runway), project)
  assert.equal(scopes[0]!.rule.command, 'git push origin main')
  assert.equal(scopes[0]!.rule.unsandboxed, true)
  assert.ok(scopes.some(s => s.rule.command === 'git push*' && s.rule.unsandboxed === true))
  const any = scopes.find(s => s.rule.command === undefined)
  assert.ok(any?.broad && !any.rule.unsandboxed, 'the "any command" scope covers the sandbox only')
  const scoped = saveScopes(op('bash', { command: 'cp a ../b', access: { write: ['../b'] } }, id.runway), project)
  assert.deepEqual(scoped[0]!.rule.access, { write: [join(root, 'b')], hosts: undefined })
  const npx = saveScopes(op('bash', { command: 'npx --yes wrangler@3 pages deploy' }, id.runway), project)
  assert.ok(npx.some(s => s.rule.command === 'npx --yes wrangler@3*' && !s.broad), 'flags ride along; the prefix is program + first argument')
  const two = saveScopes(op('bash', { command: 'npm test' }, id.runway), project)
  assert.ok(two.some(s => s.rule.command === 'npm*' && s.broad), 'the program alone is marked broad')
  const exactMake = saveScopes(op('bash', { command: 'make' }, id.runway), project)
  assert.equal(exactMake.length, 2, 'one word: exact, then the whole tool (no prefix that equals the command)')
  const mcp = saveScopes(op('mcp__gh__issue', { n: 1 }, id.mcp), project)
  assert.deepEqual(mcp[0]!.rule.inputExact, { n: 1 })
  assert.ok(mcp.at(-1)!.broad)
  const web = saveScopes(op('fetch_content', { url: 'https://project.co.uk/a' }, { kind: 'companion', companion: 'web' }), project)
  assert.deepEqual(web.filter(s => s.rule.host).map(s => s.rule.host), ['project.co.uk', '*.project.co.uk'], 'never a public suffix like *.co.uk')
})

// ---------- the gate, end to end with fake people and a fake reviewer ----------

interface Harness {
  rt: Runtime
  answers: string[]
  shown: string[]
  jevCalls: number
  run(o: ReturnType<typeof op>, opts?: { config?: Partial<RunwayConfig>; session?: string; hasUI?: boolean; jev?: 'allow' | 'deny' | 'fail' }): ReturnType<typeof gate>
}

function harness(): Harness {
  const rt = new Runtime(SandboxManager)
  const h: Harness = {
    rt, answers: [], shown: [], jevCalls: 0,
    run(o, opts = {}) {
      const session = opts.session ?? 's1'
      const ctx = {
        hasUI: opts.hasUI ?? true,
        mode: 'rpc',
        cwd: project,
        sessionManager: { getSessionId: () => session, getBranch: () => [] },
        modelRegistry: { getApiKeyForProvider: async () => 'k' },
        ui: {
          select: async (title: string, options: string[]) => {
            h.shown.push(title)
            const want = h.answers.shift() ?? 'Deny'
            return options.find(x => x.startsWith(want))
          },
          input: async () => 'not now',
          notify: () => {},
          setStatus: () => {},
        },
      } as never
      rt.sessions.set(session, { id: session, ctx, hasUI: opts.hasUI ?? true })
      const config = { ...DEFAULT_CONFIG, ...opts.config } as RunwayConfig
      return gate(o, {
        rt, config, policy, mode: config.mode ?? 'auto', ctx, sessionId: session,
        fetchImpl: async () => {
          h.jevCalls += 1
          if (opts.jev === 'fail') return new Response('{}', { status: 500 })
          return new Response(JSON.stringify({ model: 'jev', answers: jevAnswers({ allow: opts.jev !== 'deny' }) }), { status: 200 })
        },
      })
    },
  }
  return h
}

const rules = (list: unknown[]) => parseRules(list, 'personal', 't', [])

test('gate: undecided bash goes to Jev every time (no reviewer cache: the conversation may have changed)', async () => {
  const h = harness()
  const a = await h.run(op('bash', { command: 'ls -la' }, id.runway), { jev: 'allow' })
  assert.equal(a.allow, true)
  assert.equal(a.by, 'reviewer')
  assert.equal(a.sawCall, true)
  const again = await h.run(op('bash', { command: 'ls -la' }, id.runway), { jev: 'deny', hasUI: false, session: 's1' })
  assert.equal(again.allow, false)
  assert.equal(h.jevCalls, 2)
})

test('gate: a command that builds what it runs at run time cannot slip past your deny', async () => {
  const h = harness()
  const config = { permissions: rules([{ action: 'deny', command: 'git push*' }, { action: 'allow', tool: 'bash' }]) }
  assert.equal((await h.run(op('bash', { command: 'git status $(git push --force)' }, id.runway), { config })).by, 'rule')
  assert.equal((await h.run(op('bash', { command: 'env git push --force' }, id.runway), { config })).by, 'rule')
  const dynamic = await h.run(op('bash', { command: 'X=git; $X push --force' }, id.runway), { config, hasUI: false, session: 'hl' })
  assert.equal(dynamic.allow, false, 'headless: blocked, not allowed by the whole-tool allow')
  assert.match(dynamic.message!, /hides what it runs/)
  h.answers.push('Deny')
  await h.run(op('bash', { command: 'eval "$CMD"' }, id.runway), { config })
  assert.match(h.shown.at(-1)!, /builds what it runs at run time/)
  assert.equal((await h.run(op('bash', { command: 'timeout 60 npm test' }, id.runway), { config })).by, 'rule', 'plain wrappers are read through, not asked about')
  assert.equal(h.jevCalls, 0)
})

test('gate: a whole-tool grant and rule-allowed calls never widen the fence', async () => {
  const h = harness()
  h.rt.grants.add('s1', { scope: 'tool', key: 'bash', label: 'all', tool: 'bash', by: 'person' })
  assert.equal((await h.run(op('bash', { command: 'make' }, id.runway))).by, 'grant')
  const wider = await h.run(op('bash', { command: 'make', access: { hosts: ['api.example.com'] } }, id.runway), { jev: 'allow' })
  assert.equal(wider.by, 'reviewer', 'extra access is decided on its own')
  const ruled = await h.run(op('bash', { command: 'curl https://evil.example/x' }, id.runway), { config: { permissions: rules([{ action: 'allow', tool: 'bash' }]) } })
  assert.equal(ruled.by, 'rule')
  assert.equal(ruled.sawCall, false, 'hosts named in a rule-allowed command are not approved network access')
  assert.equal(ruled.fullEnv, false)
})

test('gate: a call too large for the reviewer to read in full goes to you, never to a truncated review', async () => {
  const h = harness()
  const big = op('lint', { code: 'x'.repeat(REVIEW_INPUT_LIMIT + 10) }, id.other)
  const v = await h.run(big, { hasUI: false, session: 'big', jev: 'allow' })
  assert.equal(v.allow, false)
  assert.match(v.message!, /too large for the reviewer/)
  h.answers.push('Allow once')
  assert.equal((await h.run(big, { jev: 'allow' })).by, 'person')
  assert.match(h.shown.at(-1)!, /Too large for the reviewer/)
  assert.equal(h.jevCalls, 0)
})

test('gate: your deny beats a session grant and Jev; explanation names the rule', async () => {
  const h = harness()
  const push = op('bash', { command: 'git push --force origin main' }, id.runway)
  h.rt.grants.add('s1', { scope: 'operation', key: push.key, label: 'x', tool: 'bash', by: 'person' })
  const v = await h.run(push, { config: { permissions: rules([{ action: 'deny', command: 'git push --force*', reason: 'never force-push' }]) }, jev: 'allow' })
  assert.equal(v.allow, false)
  assert.match(v.message!, /deny bash · command "git push --force\*" — never force-push/)
  assert.equal(h.jevCalls, 0)
  assert.equal(h.shown.length, 0)
})

test('gate: allow rule skips Jev; ask rule asks you; auto rule overrides a built-in allow', async () => {
  const h = harness()
  const allowed = await h.run(op('bash', { command: 'npm test' }, id.runway), { config: { permissions: rules([{ action: 'allow', command: 'npm test' }]) } })
  assert.equal(allowed.by, 'rule')
  h.answers.push('Allow once')
  const asked = await h.run(op('mcp__gh__issue', { n: 1 }, id.mcp), { config: { permissions: rules([{ action: 'ask', tool: 'mcp__gh__*' }]) } })
  assert.equal(asked.by, 'person')
  assert.match(h.shown[0]!, /Your rule asks first/)
  const reviewed = await h.run(op('read', { path: 'a.ts' }, id.builtin('read')), { config: { permissions: rules([{ action: 'auto', tool: 'read' }]) }, jev: 'allow' })
  assert.equal(reviewed.by, 'reviewer')
  assert.equal(h.jevCalls, 1)
})

test('gate: built-in file defaults; credential reads ask you even with a reviewer', async () => {
  const h = harness()
  assert.equal((await h.run(op('read', { path: 'a.ts' }, id.builtin('read')))).by, 'default')
  assert.equal((await h.run(op('write', { path: 'b.ts', content: '' }, id.builtin('write')))).by, 'default')
  const outside = await h.run(op('write', { path: join(homedir(), 'notes.txt'), content: '' }, id.builtin('write')), { jev: 'allow' })
  assert.equal(outside.by, 'reviewer', 'outside the project goes to Jev')
  h.answers.push('Deny')
  const secret = await h.run(op('read', { path: '~/.ssh/id_ed25519' }, id.builtin('read')), { jev: 'allow' })
  assert.equal(secret.allow, false)
  assert.match(h.shown.at(-1)!, /credential store/)
  assert.equal(h.jevCalls, 1, 'Jev was never asked about the credential read')
  const headless = await h.run(op('write', { path: '.git/hooks/pre-commit', content: '' }, id.builtin('write')), { hasUI: false, session: 'headless' })
  assert.equal(headless.allow, false)
  assert.match(headless.message!, /nobody is available/)
})

test('gate: Jev says no → you decide; your session choice sticks; headless just blocks', async () => {
  const h = harness()
  const call = op('mcp__db__drop', { table: 'x' }, id.mcp)
  h.answers.push('Allow for this session')
  const v = await h.run(call, { jev: 'deny' })
  assert.equal(v.allow, true)
  assert.match(h.shown[0]!, /Jev said no/)
  assert.equal((await h.run(call, { jev: 'deny' })).by, 'grant')
  const headless = await h.run(call, { jev: 'deny', session: 'h2', hasUI: false })
  assert.equal(headless.allow, false)
  assert.match(headless.message!, /reviewer/)
})

test('gate: reviewer failure falls back to you, never to allow', async () => {
  const h = harness()
  h.answers.push('Deny and tell the agent why')
  const v = await h.run(op('bash', { command: 'make deploy' }, id.runway), { jev: 'fail' })
  assert.equal(v.allow, false)
  assert.match(h.shown[0]!, /could not decide/)
  assert.match(v.message!, /not now/)
  const headless = await h.run(op('bash', { command: 'make deploy' }, id.runway), { jev: 'fail', hasUI: false, session: 'h3' })
  assert.equal(headless.allow, false)
})

test('gate: subagent asks reach the linked parent, never an unrelated session', async () => {
  const h = harness()
  // An unrelated session with a screen exists.
  await h.run(op('read', { path: 'a.ts' }, id.builtin('read')), { session: 'other' })
  h.rt.grants.setParent('child', 'parent')
  h.rt.agentNames.set('child', 'worker')
  // Register the parent with a UI, the child without.
  await h.run(op('read', { path: 'a.ts' }, id.builtin('read')), { session: 'parent' })
  h.answers.push('Deny')
  const v = await h.run(op('bash', { command: 'make' }, id.runway), { session: 'child', hasUI: false, jev: 'deny' })
  assert.equal(v.allow, false)
  assert.match(h.shown.at(-1)!, /^Subagent "worker" wants to/)
  h.rt.sessions.delete('parent')
  const orphan = await h.run(op('bash', { command: 'make' }, id.runway), { session: 'child', hasUI: false, jev: 'deny' })
  assert.match(orphan.message!, /reviewer/, 'with no linked parent screen, the child is refused, not routed to "other"')
})

test('gate: off mode allows; ask mode routes undecided calls to you instead of Jev', async () => {
  const h = harness()
  assert.equal((await h.run(op('bash', { command: 'x' }, id.runway), { config: { mode: 'off' } })).by, 'mode')
  h.answers.push('Allow once')
  const v = await h.run(op('bash', { command: 'x' }, id.runway), { config: { mode: 'ask' } })
  assert.equal(v.by, 'person')
  assert.equal(h.jevCalls, 0)
})

test('call ids are only unique per session: two sessions running the same id are tracked apart', async () => {
  const { sandboxedOperations } = await import('../../src/bash.ts')
  const { callKey } = await import('../../src/runtime.ts')
  // A pass-through "sandbox": this test is about bookkeeping, not containment.
  const fake = { wrapWithSandbox: async (c: string) => c, annotateStderrWithSandboxFailures: (_: string, t: string) => t, cleanupAfterCommand: () => {} }
  const rt = new Runtime(fake as never)
  const ctxFor = (session: string) => ({ sessionManager: { getSessionId: () => session } }) as never
  const policyFor = () => policy
  const seen: number[] = []
  const run = (session: string, hosts: string[]) => sandboxedOperations(rt, 'call_1', ctxFor(session), policyFor, [], { write: [], endpoints: hosts.map(host => ({ host, port: undefined })) })
    .exec('sleep 0.3', project, { onData: () => {}, env: process.env } as never)
  const a = run('parent', ['a.example'])
  const b = run('child', [])
  await new Promise(r => setTimeout(r, 120))
  seen.push(rt.running.size)
  assert.deepEqual(rt.running.get(callKey('parent', 'call_1'))?.endpoints, [{ host: 'a.example', port: undefined }])
  assert.deepEqual(rt.running.get(callKey('child', 'call_1'))?.endpoints, [], "the child's command doesn't inherit the parent's approved host")
  await Promise.all([a, b])
  assert.deepEqual(seen, [2])
  assert.equal(rt.running.size, 0)
  assert.notEqual(callKey('parent', 'call_1'), callKey('child', 'call_1'))
})

test('settings: a typo never widens a rule; a broken restrictive rule still restricts', () => {
  const ctx = { policy }
  const problems: string[] = []
  const parsed = parseRules([
    { action: 'allow', tool: 'bash', commmand: 'git status' },
    { action: 'deny', tool: 'bash', comand: 'git push*' },
    { action: 'ask', commandd: 'rm *' },
    { action: 'denny', tool: 'mcp__db__*' },
    { action: 'allow', tool: 'bash', access: { write: ['/x'], writes: ['/'] } },
    { action: 'deny', tool: 'bash', inputExact: 'nope' },
    { action: 'allow', tool: 'lint', inputExact: { fix: true } },
    'not a rule',
  ], 'personal', 'runway.json', problems)
  assert.equal(problems.length, 7, problems.join('\n'))
  assert.ok(!parsed.some(r => r.action === 'allow' && r.tool === 'bash'), 'the misspelled allow is not a whole-bash allow')
  const bash = op('bash', { command: 'ls' }, id.runway)
  const deny = strongestMatch(parsed, bash, ctx, ['deny'])
  assert.ok(deny?.invalid, 'the broken deny on bash blocks bash until fixed')
  assert.match(deny!.reason!, /can't read this rule/)
  assert.equal(strongestMatch(parsed, op('mcp__db__drop', {}, id.mcp), ctx)?.action, 'ask', 'an unreadable action asks about its tool')
  assert.equal(strongestMatch(parsed, op('read', { path: 'a.ts' }, id.builtin('read')), ctx)?.action, 'ask', 'a rule that is not an object asks about every tool')
  assert.ok(parsed.some(r => r.action === 'allow' && r.tool === 'lint' && r.inputExact), 'an inputExact-only rule is valid')
  const notAList: string[] = []
  const all = parseRules({ action: 'deny', tool: 'bash' }, 'personal', 'runway.json', notAList)
  assert.equal(strongestMatch(all, bash, ctx)?.action, 'ask', 'an unreadable permissions list asks about everything')
  assert.match(notAList[0]!, /every tool call asks you/)
})

test('gate: headless, a broken rule refuses with an explanation instead of allowing', async () => {
  const h = harness()
  const config = { permissions: parseRules([{ action: 'allow', tool: 'bash' }, { action: 'deny', tool: 'bash', comand: 'git push*' }], 'personal', 'runway.json', []) }
  const v = await h.run(op('bash', { command: 'git push' }, id.runway), { config, hasUI: false, session: 'hb' })
  assert.equal(v.allow, false)
  assert.match(v.message!, /can't read this rule/)
})

test('network: your rules come before every fast path; known hosts keep their port; closed never reviews; open still obeys rules', async () => {
  const { connectionVerdict, backgroundVerdict } = await import('../../src/network.ts')
  const { networkOperation } = await import('../../src/permissions/operation.ts')
  const p = buildPolicy(project, { ...DEFAULT_CONFIG, allowHosts: ['api.example.dev:443'] }, agentDir)
  const net = (host: string, port?: number) => networkOperation(host, port, project, ['curl …'])
  const cfg = (over: Partial<RunwayConfig>) => ({ ...DEFAULT_CONFIG, ...over }) as RunwayConfig
  const known = 'registry.npmjs.org'
  assert.equal(connectionVerdict(net(known, 443), cfg({}), p, []), 'allow')
  assert.equal(connectionVerdict(net(known, 443), cfg({ permissions: rules([{ action: 'deny', host: known }]) }), p, []), 'deny')
  assert.equal(connectionVerdict(net(known, 443), cfg({ permissions: rules([{ action: 'auto', host: known }]) }), p, []), 'gate', 'an explicit auto rule is reviewed even for a known host')
  assert.equal(connectionVerdict(net('x.example', 443), cfg({ permissions: rules([{ action: 'ask', host: 'x.example' }]) }), p, [{ host: 'x.example', port: undefined }]), 'gate', 'an ask rule beats an endpoint approved with the command')
  assert.equal(connectionVerdict(net('api.example.dev', 443), cfg({}), p, []), 'allow')
  assert.equal(connectionVerdict(net('api.example.dev', 22), cfg({}), p, []), 'gate', 'allowHosts "host:443" does not cover port 22')
  assert.equal(connectionVerdict(net('new.example', 443), cfg({ network: 'closed' }), p, []), 'deny')
  assert.equal(connectionVerdict(net('new.example', 443), cfg({ network: 'closed', permissions: rules([{ action: 'auto', host: 'new.example' }]) }), p, []), 'deny', 'closed is never reviewed')
  assert.equal(connectionVerdict(net('new.example', 443), cfg({ network: 'open' }), p, []), 'allow')
  assert.equal(connectionVerdict(net('evil.example', 443), cfg({ network: 'open', permissions: rules([{ action: 'deny', host: 'evil.example' }]) }), p, []), 'deny', 'open mode keeps your deny rules')
  assert.equal(connectionVerdict(net('new.example', 443), cfg({}), p, []), 'gate')
  // Left behind by a finished command: nobody can be asked for it.
  assert.equal(backgroundVerdict(net(known, 443), cfg({}), p), true)
  assert.equal(backgroundVerdict(net(known, 443), cfg({ permissions: rules([{ action: 'auto', host: known }]) }), p), false)
  assert.equal(backgroundVerdict(net('new.example', 443), cfg({}), p), false)
})

test('approvals handed from the gate to bash are per session: same call id, interleaved, never crossed', () => {
  const rt = new Runtime(SandboxManager)
  const cmd = op('bash', { command: 'echo "$TOKEN"', escalate: true }, id.runway)
  // A person approved the parent's call (keeps the environment); Jev approved the child's, same provider id.
  rt.recordApproval('parent', 'call_1', { inputKey: cmd.key, fullEnv: true, endpoints: [{ host: 'a.example', port: undefined }] })
  rt.recordApproval('child', 'call_1', { inputKey: cmd.key, fullEnv: false, endpoints: [] })
  assert.equal(rt.takeApproval('child', 'call_1', cmd.key)?.fullEnv, false, "the child never gets the parent's person approval")
  assert.equal(rt.takeApproval('parent', 'call_1', cmd.key)?.fullEnv, true)
  assert.equal(rt.takeApproval('parent', 'call_1', cmd.key), undefined, 'used up')
  rt.recordApproval('parent', 'call_2', { inputKey: cmd.key, fullEnv: true, endpoints: [] })
  assert.equal(rt.takeApproval('parent', 'call_2', op('bash', { command: 'rm -rf ~', escalate: true }, id.runway).key), undefined, 'changed arguments: decide again')
  assert.equal(rt.approved.size, 0)
})

test('a malformed auto rule keeps review: it asks until fixed instead of letting a built-in allow through', async () => {
  const h = harness()
  const problems: string[] = []
  const config = { permissions: parseRules([{ action: 'auto', tool: 'read', paht: 'src/**' }], 'personal', 'runway.json', problems) }
  assert.match(problems[0]!, /unknown field "paht".*asks you about every read call/)
  const headless = await h.run(op('read', { path: 'a.ts' }, id.builtin('read')), { config, hasUI: false, session: 'auto-broken' })
  assert.equal(headless.allow, false, 'not the built-in project-read allow')
  h.answers.push('Allow once')
  assert.equal((await h.run(op('read', { path: 'a.ts' }, id.builtin('read')), { config })).by, 'person')
  assert.equal(h.jevCalls, 0)
})
