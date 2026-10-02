import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { makeHome, PACKAGE_ROOT, READ_BLOCKED, runRpc, SECRET_CANARY, startFakeServer } from '../support/harness.ts'
import type { ChatRequest, FakeServer, Home, PiEvent, Reply } from '../support/harness.ts'

// The companions Runway bundles (pi-subagents, pi-plan-mode, pi-web-access),
// driven through the real local Pi with only Runway listed in settings.

let server: FakeServer
before(async () => {
  server = await startFakeServer()
})
after(async () => {
  await server.close()
})

// ---------- helpers (local to this file) ----------

const TOOL_TIMEOUT = 120_000

function userText(req: ChatRequest): string {
  return req.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join('\n')
}

/** Which child (by marker in its task prompt) a model request belongs to, or undefined for the parent. */
function childOf(req: ChatRequest, markers: string[]): string | undefined {
  const text = userText(req)
  return markers.find(m => text.includes(m))
}

function turnOf(req: ChatRequest): number {
  return req.messages.filter(m => m.role === 'assistant').length
}

function toolResultsIn(req: ChatRequest): string[] {
  return req.messages.filter(m => m.role === 'tool').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
}

function toolNames(req: ChatRequest): string[] {
  return (req.tools ?? []).map(t => t.function.name)
}

/**
 * A parent script plus one script per child (keyed by a marker that appears in
 * the child's task prompt). Each script is a list of replies by turn.
 */
function family(parent: Reply[], children: Record<string, Reply[]>): (req: ChatRequest) => Reply {
  const markers = Object.keys(children)
  return req => {
    const child = childOf(req, markers)
    const steps = child ? children[child]! : parent
    return steps[turnOf(req)] ?? { text: child ? `${child} finished` : 'parent done' }
  }
}

function spawn(marker: string, type = 'worker'): Reply {
  return { tool: 'subagent', args: { prompt: `${marker}: do the chores you are told`, description: 'chores', subagent_type: type } }
}

function writeAgent(h: Home, name: string, model = 'fake/fake-small'): void {
  mkdirSync(join(h.agentDir, 'agents'), { recursive: true })
  writeFileSync(join(h.agentDir, 'agents', `${name}.md`), `---\ndescription: Does small chores\ntools: read, bash, write, edit\nmodel: ${model}\n---\nYou are a worker. Do exactly what the task says.\n`)
}

type Answer = (req: PiEvent) => string | undefined

/** Answer `select` dialogs by picking the first option that starts with the returned prefix. */
function answering(log: PiEvent[], pick: Answer): (req: PiEvent) => Record<string, unknown> {
  return req => {
    log.push(req)
    if (req.method !== 'select') return { cancelled: true }
    const prefix = pick(req)
    const options = (req.options as string[] | undefined) ?? []
    const value = prefix === undefined ? undefined : options.find(o => o.startsWith(prefix))
    return value === undefined ? { cancelled: true } : { value }
  }
}

const notices = (events: PiEvent[]) => events.filter(e => e.type === 'extension_ui_request' && e.method === 'notify').map(e => String(e.message))
const commandOf = (j: { action: Record<string, unknown> }) => String(j.action.command ?? '')

// ---------- a. bundled subagents ----------

test('a. bundled subagents: only Runway installed; per-agent model; child calls reviewed with its own name and transcript; child bash sandboxed', async () => {
  const h = makeHome(server, { models: ['fake-model', 'fake-small'] })
  try {
    const settings = JSON.parse(readFileSync(join(h.agentDir, 'settings.json'), 'utf8')) as { packages: string[] }
    assert.deepEqual(settings.packages, [PACKAGE_ROOT], 'only Runway is installed')
    writeAgent(h, 'worker')
    const reqStart = server.requests.length
    const jevStart = server.jevRequests.length
    server.setJev(() => ({ allow: true }))
    server.setScript(family([spawn('CHILD TASK A')], {
      'CHILD TASK A': [
        { tool: 'bash', args: { command: 'cat ~/.ssh/id_ed25519' } },
        { tool: 'bash', args: { command: 'echo child > child.txt && echo wrote' } },
      ],
    }))
    const dialogs: PiEvent[] = []
    const r = await runRpc(h, ['delegate the chores'], answering(dialogs, () => 'Deny'), TOOL_TIMEOUT)
    const requests = server.requests.slice(reqStart)
    const parentReqs = requests.filter(q => !childOf(q, ['CHILD TASK A']))
    const childReqs = requests.filter(q => childOf(q, ['CHILD TASK A']))
    assert.ok(toolNames(parentReqs[0]!).includes('subagent'), `subagent tool offered to the model: ${toolNames(parentReqs[0]!)}`)
    assert.equal(toolNames(parentReqs[0]!).filter(n => n === 'subagent').length, 1)
    assert.ok(childReqs.length >= 3, `child ran (${childReqs.length} requests)`)
    assert.deepEqual([...new Set(childReqs.map(q => q.model))], ['fake-small'], 'child runs on its agent file model')
    assert.deepEqual([...new Set(parentReqs.map(q => q.model))], ['fake-model'], 'parent stays on its own model')
    const childResults = toolResultsIn(childReqs.at(-1)!)
    assert.equal(childResults.length, 2, JSON.stringify(childResults))
    assert.match(childResults[0]!, READ_BLOCKED, 'child bash is sandboxed')
    assert.ok(!JSON.stringify(requests).includes(SECRET_CANARY), 'the canary never reaches any model')
    assert.ok(!JSON.stringify(r.events).includes(SECRET_CANARY), 'the canary never reaches the RPC stream')
    assert.match(childResults[1]!, /wrote/)
    assert.ok(existsSync(join(h.project, 'child.txt')), 'child wrote inside the project')
    const reviews = server.jevRequests.slice(jevStart)
    const childReviews = reviews.filter(j => j.action.agentName === 'worker')
    assert.deepEqual(childReviews.map(commandOf), ['cat ~/.ssh/id_ed25519', 'echo child > child.txt && echo wrote'], 'both child commands reviewed as the worker')
    for (const j of childReviews) {
      assert.equal(j.action.toolName, 'bash')
      assert.equal(j.action.kind, 'shell')
      const transcript = JSON.stringify(j.transcript)
      assert.match(transcript, /CHILD TASK A/, "the reviewer reads the child's own conversation")
      assert.doesNotMatch(transcript, /delegate the chores/, "not the parent's")
    }
    const spawns = reviews.filter(j => j.action.toolName === 'subagent')
    assert.equal(spawns.length, 1, 'starting a subagent is reviewed like any other call that acts (it spends model time on a task)')
    assert.match(JSON.stringify(spawns[0]!.action.input), /CHILD TASK A/, 'with the task it is given')
    assert.equal(dialogs.filter(d => d.method === 'select').length, 0, `no dialogs: ${dialogs.map(d => d.title)}`)
  } finally {
    h.cleanup()
  }
})

// ---------- b. attribution ----------

test('b. attribution: a Jev-denied child call is put to the person in the parent session as Subagent "worker"; Deny blocks only that call', async () => {
  const h = makeHome(server, { models: ['fake-model', 'fake-small'] })
  try {
    writeAgent(h, 'worker')
    const reqStart = server.requests.length
    server.setJev(state => ({ allow: !String(state.action.command ?? '').includes('risky-child') }))
    server.setScript(family([spawn('CHILD TASK B'), { tool: 'bash', args: { command: 'echo parent-ok' } }], {
      'CHILD TASK B': [
        { tool: 'bash', args: { command: 'echo risky-child > risky.txt' } },
        { tool: 'bash', args: { command: 'echo after-deny' } },
      ],
    }))
    const dialogs: PiEvent[] = []
    const r = await runRpc(h, ['delegate the chores'], answering(dialogs, () => 'Deny'), TOOL_TIMEOUT)
    const selects = dialogs.filter(d => d.method === 'select')
    assert.equal(selects.length, 1, `one dialog: ${JSON.stringify(selects.map(d => d.title))}`)
    const title = String(selects[0]!.title)
    assert.ok(title.startsWith('Subagent "worker" wants to run a command (bash):'), title)
    assert.match(title, /echo risky-child > risky\.txt/)
    assert.match(title, /Jev said no/)
    const options = selects[0]!.options as string[]
    assert.ok(options.includes('Allow once') && options.includes('Deny'), JSON.stringify(options))
    const childReqs = server.requests.slice(reqStart).filter(q => childOf(q, ['CHILD TASK B']))
    const childResults = toolResultsIn(childReqs.at(-1)!)
    assert.equal(childResults.length, 2, JSON.stringify(childResults))
    assert.match(childResults[0]!, /user (declined|did not approve)/)
    assert.match(childResults[1]!, /after-deny/, 'the next child call still runs')
    assert.ok(!existsSync(join(h.project, 'risky.txt')), 'the denied command never ran')
    const parentBash = r.toolResults.find(t => t.toolName === 'bash')
    assert.ok(parentBash, 'parent continued after the child')
    assert.equal(parentBash.isError, false, parentBash.text)
    assert.match(parentBash.text, /parent-ok/)
    const sub = r.toolResults.find(t => t.toolName === 'subagent')
    assert.equal(sub?.isError, false, 'the subagent run itself was not blocked')
  } finally {
    h.cleanup()
  }
})

// ---------- c. session grants ----------

test('c. session grants: a parent grant covers the child; a child grant never covers the parent', async () => {
  const h = makeHome(server, { models: ['fake-model', 'fake-small'] })
  try {
    writeAgent(h, 'worker')
    const reqStart = server.requests.length
    const jevStart = server.jevRequests.length
    server.setJev(() => ({ allow: false }))
    server.setScript(family([
      { tool: 'bash', args: { command: 'echo shared-op' } },
      spawn('CHILD TASK C'),
      { tool: 'bash', args: { command: 'echo child-op' } },
    ], {
      'CHILD TASK C': [
        { tool: 'bash', args: { command: 'echo shared-op' } },
        { tool: 'bash', args: { command: 'echo child-op' } },
        { tool: 'bash', args: { command: 'echo child-op' } },
      ],
    }))
    const dialogs: PiEvent[] = []
    const r = await runRpc(h, ['go'], answering(dialogs, req => {
      const title = String(req.title)
      // The parent's re-run of the child's operation: allow once only.
      if (title.startsWith('The agent') && title.includes('child-op')) return 'Allow once'
      return 'Allow for this session:'
    }), TOOL_TIMEOUT)
    const titles = dialogs.filter(d => d.method === 'select').map(d => String(d.title).split('\n').slice(0, 2).join(' | '))
    assert.deepEqual(titles, [
      'The agent wants to run a command (bash): | $ echo shared-op',
      'The agent wants to start a subagent (subagent): | subagent',
      'Subagent "worker" wants to run a command (bash): | $ echo child-op',
      'The agent wants to run a command (bash): | $ echo child-op',
    ], 'parent-approved op passes in the child; child-approved op is asked again in the parent')
    const reviews = server.jevRequests.slice(jevStart).map(j => `${j.action.agentName ?? 'parent'}: ${commandOf(j) || j.action.toolName}`)
    assert.deepEqual(reviews, ['parent: echo shared-op', 'parent: subagent', 'worker: echo child-op', 'parent: echo child-op'], 'the inherited op and the repeated child op never went to Jev')
    const childReqs = server.requests.slice(reqStart).filter(q => childOf(q, ['CHILD TASK C']))
    const childResults = toolResultsIn(childReqs.at(-1)!)
    assert.equal(childResults.length, 3, JSON.stringify(childResults))
    assert.match(childResults[0]!, /shared-op/)
    assert.match(childResults[1]!, /child-op/)
    assert.match(childResults[2]!, /child-op/)
    const parentBash = r.toolResults.filter(t => t.toolName === 'bash')
    assert.equal(parentBash.length, 2)
    assert.ok(parentBash.every(t => !t.isError), JSON.stringify(parentBash))
  } finally {
    h.cleanup()
  }
})

// ---------- g. subagent disposal ----------

test('g. after a child finishes, a second child runs and dialogs are still attributed correctly (no stale child sessions)', async () => {
  const h = makeHome(server, { models: ['fake-model', 'fake-small'] })
  try {
    writeAgent(h, 'worker')
    writeAgent(h, 'helper')
    const reqStart = server.requests.length
    const jevStart = server.jevRequests.length
    server.setJev(state => ({ allow: !commandOf(state).includes('needs-person') }))
    server.setScript(family([
      spawn('CHILD TASK G1', 'worker'),
      spawn('CHILD TASK G2', 'helper'),
      { tool: 'bash', args: { command: 'cat ~/.ssh/id_ed25519; echo needs-person-parent' } },
    ], {
      'CHILD TASK G1': [{ tool: 'bash', args: { command: 'echo needs-person-1' } }],
      'CHILD TASK G2': [
        { tool: 'bash', args: { command: 'echo needs-person-2' } },
        { tool: 'bash', args: { command: 'cat ~/.ssh/id_ed25519' } },
      ],
    }))
    const dialogs: PiEvent[] = []
    const r = await runRpc(h, ['two rounds of chores'], answering(dialogs, () => 'Allow once'), TOOL_TIMEOUT)
    const titles = dialogs.filter(d => d.method === 'select').map(d => String(d.title).split('\n').slice(0, 2).join(' | '))
    assert.deepEqual(titles, [
      'Subagent "worker" wants to run a command (bash): | $ echo needs-person-1',
      'Subagent "helper" wants to run a command (bash): | $ echo needs-person-2',
      'The agent wants to run a command (bash): | $ cat ~/.ssh/id_ed25519; echo needs-person-parent',
    ])
    const reviews = server.jevRequests.slice(jevStart)
    assert.deepEqual(reviews.map(j => `${j.action.agentName ?? 'parent'}:${j.action.toolName}`), ['parent:subagent', 'worker:bash', 'parent:subagent', 'helper:bash', 'helper:bash', 'parent:bash'])
    const subs = r.toolResults.filter(t => t.toolName === 'subagent')
    assert.equal(subs.length, 2)
    assert.ok(subs.every(s => !s.isError), JSON.stringify(subs))
    const g2 = server.requests.slice(reqStart).filter(q => childOf(q, ['CHILD TASK G2']))
    const g2Results = toolResultsIn(g2.at(-1)!)
    assert.match(g2Results[0]!, /needs-person-2/)
    assert.match(g2Results[1]!, READ_BLOCKED, 'the second child is still sandboxed')
    const parentBash = r.toolResults.find(t => t.toolName === 'bash')
    assert.ok(parentBash)
    assert.match(parentBash.text, READ_BLOCKED, "the parent's sandbox survived both children ending")
    assert.match(parentBash.text, /needs-person-parent/)
    assert.ok(!JSON.stringify(r.events).includes(SECRET_CANARY))
  } finally {
    h.cleanup()
  }
})

// ---------- d. the user's own copy wins ----------

test("d. duplicate detection: with the user's own pi-subagents listed, Runway skips its copy; one subagent tool, no conflict", async () => {
  const own = join(PACKAGE_ROOT, 'node_modules', '@gotgenes', 'pi-subagents')
  const h = makeHome(server, { models: ['fake-model', 'fake-small'], extraPackages: [own] })
  try {
    writeAgent(h, 'worker')
    const reqStart = server.requests.length
    const jevStart = server.jevRequests.length
    server.setJev(() => ({ allow: true }))
    server.setScript(family([spawn('CHILD TASK D')], { 'CHILD TASK D': [{ tool: 'bash', args: { command: 'echo from-own-copy' } }] }))
    const r = await runRpc(h, ['/runway doctor', 'delegate'], () => ({ cancelled: true }), TOOL_TIMEOUT)
    const text = notices(r.events).join('\n')
    assert.match(text, /Subagents: your own @gotgenes\/pi-subagents/, text)
    assert.match(text, /Plan mode: bundled @narumitw\/pi-plan-mode@/)
    assert.match(text, /Web search and fetch: bundled pi-web-access@/)
    const parentReqs = server.requests.slice(reqStart).filter(q => !childOf(q, ['CHILD TASK D']))
    assert.ok(parentReqs.length > 0)
    assert.equal(toolNames(parentReqs[0]!).filter(n => n === 'subagent').length, 1, `exactly one subagent tool: ${toolNames(parentReqs[0]!)}`)
    assert.doesNotMatch(r.stderr, /conflict|already registered|duplicate/i, r.stderr)
    assert.doesNotMatch(text, /conflict|already registered|did not load/i)
    const sub = r.toolResults.find(t => t.toolName === 'subagent')
    assert.equal(sub?.isError, false, sub?.text)
    // The user's copy is not Runway's: starting a subagent through it is reviewed like any other extension tool.
    const reviews = server.jevRequests.slice(jevStart)
    assert.equal(reviews.filter(j => j.action.toolName === 'subagent').length, 1, 'the user-installed subagent tool is reviewed (not a bundled helper)')
    // Linking still works: the lifecycle events come from the user's copy on the same event bus.
    const child = reviews.find(j => commandOf(j) === 'echo from-own-copy')
    assert.ok(child, 'the child command was reviewed')
    assert.equal(child.action.agentName, 'worker')
  } finally {
    h.cleanup()
  }
})

test("d2. filtered copies: a disabled own copy lets Runway load its bundled one; a filter that loads nothing is reported, not silently assumed", async () => {
  const own = join(PACKAGE_ROOT, 'node_modules', '@gotgenes', 'pi-subagents')
  const off = makeHome(server, { models: ['fake-model', 'fake-small'] })
  try {
    const settingsPath = join(off.agentDir, 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { packages: unknown[] }
    settings.packages.push({ source: own, extensions: [] })
    writeFileSync(settingsPath, JSON.stringify(settings))
    server.setScript(() => ({ text: 'ok' }))
    const reqStart = server.requests.length
    const r = await runRpc(off, ['/runway doctor', 'hello'], () => ({ cancelled: true }), TOOL_TIMEOUT)
    const text = notices(r.events).join('\n')
    assert.match(text, /Subagents: bundled @gotgenes\/pi-subagents@/, text)
    assert.equal(toolNames(server.requests[reqStart]!).filter(n => n === 'subagent').length, 1)
  } finally {
    off.cleanup()
  }
  const none = makeHome(server, { models: ['fake-model', 'fake-small'] })
  try {
    const settingsPath = join(none.agentDir, 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { packages: unknown[] }
    settings.packages.push({ source: own, extensions: ['!**'] })
    writeFileSync(settingsPath, JSON.stringify(settings))
    server.setScript(() => ({ text: 'ok' }))
    const reqStart = server.requests.length
    const r = await runRpc(none, ['/runway doctor', 'hello'], () => ({ cancelled: true }), TOOL_TIMEOUT)
    const text = notices(r.events).join('\n')
    assert.ok(!toolNames(server.requests[reqStart]!).includes('subagent'), 'the filter really loads nothing')
    assert.match(text, /your @gotgenes\/pi-subagents is listed but not loaded/, text)
  } finally {
    none.cleanup()
  }
})

// ---------- e. identity, not names ----------

function writeExtension(h: Home): string {
  const dir = join(h.home, 'exts', 'notes-ext')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'notes-ext', version: '1.0.0', type: 'module', keywords: ['pi-package'], pi: { extensions: ['./index.js'] } }))
  writeFileSync(join(dir, 'index.js'), `
const params = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
export default function (pi) {
  for (const name of ['notes_lookup', 'tool_search_custom']) {
    pi.registerTool({
      name, label: name, description: 'Look something up in the notes (' + name + ')', parameters: params,
      async execute(_id, input) { return { content: [{ type: 'text', text: name + ' ran: ' + input.query }], details: {} } },
    })
  }
}
`)
  return dir
}

test('e. identity honesty: third-party tools go to Jev whatever their name; bundled plan helpers do not', async () => {
  const h = makeHome(server, { runwayConfig: { onDeny: 'block' } })
  try {
    const ext = writeExtension(h)
    const settingsPath = join(h.agentDir, 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { packages: string[] }
    settings.packages.push(ext)
    writeFileSync(settingsPath, JSON.stringify(settings))
    const reqStart = server.requests.length
    const jevStart = server.jevRequests.length
    server.setJev(state => ({ allow: state.action.toolName === 'notes_lookup' }))
    const question = {
      questions: [{ id: 'db_choice', header: 'Database', question: 'Which database should the plan use?', options: [{ label: 'SQLite', description: 'Simple, local.' }, { label: 'Postgres', description: 'Scales further.' }] }],
    }
    server.setScript(req => {
      const last = JSON.stringify(req.messages.filter(m => m.role === 'user').at(-1)?.content ?? '')
      const turn = req.messages.slice(req.messages.findLastIndex(m => m.role === 'user')).filter(m => m.role === 'assistant').length
      if (last.includes('use the notes')) {
        return [{ tool: 'notes_lookup', args: { query: 'release checklist' } }, { tool: 'tool_search_custom', args: { query: 'deploy' } }][turn] ?? { text: 'notes done' }
      }
      if (last.includes('plan the change')) {
        return [{ tool: 'plan_mode_question', args: question }, { tool: 'plan_mode_complete', args: { plan: '1. Add a notes table.\n2. Test it.' } }][turn] ?? { text: 'plan done' }
      }
      return { text: 'ok' }
    })
    const dialogs: PiEvent[] = []
    const r = await runRpc(h, ['use the notes', '/plan start', 'plan the change'], answering(dialogs, req => {
      const title = String(req.title)
      if (/wants to \(/.test(title)) return 'Deny'
      // Plan mode's own dialogs: answer the question, then keep the ready plan without implementing it.
      if (title.startsWith('Proposed plan ready')) return 'Stay in Plan mode'
      return ((req.options as string[] | undefined) ?? [])[0]
    }), TOOL_TIMEOUT)
    const firstReq = server.requests[reqStart]!
    assert.ok(toolNames(firstReq).includes('notes_lookup') && toolNames(firstReq).includes('tool_search_custom'), `custom tools are offered: ${toolNames(firstReq)}`)
    const reviews = server.jevRequests.slice(jevStart)
    assert.deepEqual(reviews.map(j => j.action.toolName), ['notes_lookup', 'tool_search_custom'], 'both custom tools were reviewed; the plan helpers were not')
    for (const j of reviews) {
      assert.equal(j.action.kind, 'tool', `custom tools are plain tools, not coordination helpers: ${JSON.stringify(j.action)}`)
      assert.match(String(j.action.execution), /extension tool inside Pi/)
    }
    const byName = (n: string) => r.toolResults.filter(t => t.toolName === n)
    assert.match(byName('notes_lookup')[0]?.text ?? '', /notes_lookup ran: release checklist/, 'Jev allowed it, so it ran')
    assert.equal(byName('tool_search_custom')[0]?.isError, true)
    assert.match(byName('tool_search_custom')[0]?.text ?? '', /Blocked by Runway's reviewer/)
    const q = byName('plan_mode_question')[0]
    assert.ok(q, `plan_mode_question was called: ${JSON.stringify(r.toolResults.map(t => t.toolName))}`)
    assert.equal(q.isError, false, q.text)
    assert.match(q.text, /"answer": "SQLite"/, 'the question really ran in Plan mode and reached the person')
    const c = byName('plan_mode_complete')[0]
    assert.ok(c, 'plan_mode_complete was called')
    assert.equal(c.isError, false, c.text)
    assert.match(c.text, /Proposed Plan/)
    assert.ok(dialogs.some(d => String(d.title).startsWith('Proposed plan ready')), "plan mode's own review appeared")
    assert.equal(dialogs.filter(d => /wants to \(/.test(String(d.title))).length, 0, 'Runway asked nobody about the plan helpers')
  } finally {
    h.cleanup()
  }
})

// ---------- f. web ----------

test('f. web: fetch_content is reviewed by Jev as a web call naming the host; a deny rule blocks *.blocked.test without fetching', async () => {
  let hits = 0
  const probe = createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'text/plain' }).end('probe page')
  })
  await new Promise<void>(res => probe.listen(0, '127.0.0.1', res))
  const port = (probe.address() as AddressInfo).port
  const h = makeHome(server, { runwayConfig: { onDeny: 'block', permissions: [{ action: 'deny', tool: 'fetch_content', host: '*.blocked.test', reason: 'test block' }] } })
  try {
    const reqStart = server.requests.length
    const jevStart = server.jevRequests.length
    server.setJev(() => ({ allow: false }))
    server.setScript((req, turn) => {
      if (turn === 0) assert.ok(toolNames(req).includes('fetch_content'), `fetch_content offered: ${toolNames(req)}`)
      return [
        { tool: 'fetch_content', args: { url: `http://127.0.0.1:${port}/reviewed-page` } },
        { tool: 'fetch_content', args: { url: 'https://docs.example.test/guide' } },
        { tool: 'fetch_content', args: { url: 'https://api.blocked.test/secret' } },
      ][turn] ?? { text: 'done' }
    })
    const dialogs: PiEvent[] = []
    const r = await runRpc(h, ['read those pages'], answering(dialogs, () => 'Deny'), TOOL_TIMEOUT)
    assert.ok(toolNames(server.requests[reqStart]!).includes('fetch_content'), 'bundled fetch_content exists')
    const fetches = r.toolResults.filter(t => t.toolName === 'fetch_content')
    assert.equal(fetches.length, 3, JSON.stringify(r.toolResults))
    assert.ok(fetches.every(f => f.isError), JSON.stringify(fetches))
    assert.match(fetches[0]!.text, /Blocked by Runway's reviewer/)
    assert.match(fetches[1]!.text, /Blocked by Runway's reviewer/)
    assert.match(fetches[2]!.text, /Blocked by a rule in your Runway settings: deny fetch_content · host "\*\.blocked\.test" — test block/)
    const reviews = server.jevRequests.slice(jevStart)
    assert.equal(reviews.length, 2, 'the rule-denied fetch never reached Jev')
    assert.deepEqual(reviews.map(j => [j.action.toolName, j.action.kind, j.action.target]), [
      ['fetch_content', 'web', '127.0.0.1'],
      ['fetch_content', 'web', 'docs.example.test'],
    ])
    assert.match(JSON.stringify(reviews[1]!.action.input), /docs\.example\.test\/guide/)
    assert.equal(hits, 0, 'nothing was fetched')
    assert.equal(dialogs.filter(d => d.method === 'select').length, 0)
  } finally {
    h.cleanup()
    await new Promise(res => probe.close(res))
  }
})

// Known gap (reported, not fixed here): with models that accept mid-conversation tool
// additions, pi-web-access starts with only its `web_enable` loader active. That loader
// only switches the bundled web tools on ("Does not search or fetch"), yet Runway sends
// it to Jev like an arbitrary extension tool, so a Jev "no" (or ask mode) can keep web
// access from ever being enabled.
test('f2. web: the bundled web_enable loader is a helper, not reviewed', async () => {
  const h = makeHome(server, { runwayConfig: { onDeny: 'block' } })
  try {
    const modelsPath = join(h.agentDir, 'models.json')
    const models = JSON.parse(readFileSync(modelsPath, 'utf8')) as { providers: { fake: { models: Record<string, unknown>[] } } }
    models.providers.fake.models[0]!.compat = { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true }
    writeFileSync(modelsPath, JSON.stringify(models))
    const reqStart = server.requests.length
    const jevStart = server.jevRequests.length
    server.setJev(() => ({ allow: false }))
    server.setScript((_req, turn) => (turn === 0 ? { tool: 'web_enable', args: {} } : { text: 'done' }))
    const r = await runRpc(h, ['look it up online'], () => ({ cancelled: true }), TOOL_TIMEOUT)
    const offered = toolNames(server.requests[reqStart]!)
    assert.ok(offered.includes('web_enable') && !offered.includes('fetch_content'), `dynamic web tools: ${offered}`)
    assert.equal(server.jevRequests.slice(jevStart).length, 0, 'web_enable was sent to Jev')
    const enable = r.toolResults.find(t => t.toolName === 'web_enable')
    assert.equal(enable?.isError, false, enable?.text)
    assert.match(enable?.text ?? '', /Enabled: .*fetch_content/)
  } finally {
    h.cleanup()
  }
})
