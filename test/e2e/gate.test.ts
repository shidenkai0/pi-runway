import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ENV_CANARY, makeHome, runPrint, runRpc, sequence, startFakeServer } from '../support/harness.ts'
import type { FakeServer, PiEvent } from '../support/harness.ts'

// The permission gate with the real Pi binary: rules, reviews, approvals, scoped access.

let server: FakeServer
before(async () => {
  server = await startFakeServer()
})
after(async () => {
  await server.close()
})

const dialogs = (events: PiEvent[]) => events.filter(e => e.type === 'extension_ui_request' && e.method === 'select').map(e => String(e.title))
const reviewsSince = (n: number) => server.jevRequests.slice(n)

test('every command is reviewed with its real arguments and the task, every time; Pi file edits in the project are not', async () => {
  const h = makeHome(server)
  try {
    const before = server.jevRequests.length
    server.setJev(() => ({ allow: true }))
    server.setScript(sequence([
      { tool: 'read', args: { path: 'package.json' } },
      { tool: 'write', args: { path: 'src/util.js', content: 'module.exports = 2\n' } },
      { tool: 'bash', args: { command: 'ls' } },
      { tool: 'bash', args: { command: 'node -e "console.log(require(\'./src/util.js\'))"' } },
      { tool: 'bash', args: { command: 'ls' } },
    ]))
    const r = await runRpc(h, ['tidy up the util module'], () => {
      throw new Error('no dialog expected')
    })
    assert.deepEqual(r.toolResults.map(t => t.isError), [false, false, false, false, false])
    assert.match(r.toolResults[3]!.text, /2/)
    const reviews = reviewsSince(before)
    assert.deepEqual(reviews.map(j => j.action.command), ['ls', `node -e "console.log(require('./src/util.js'))"`, 'ls'], 'a repeat is reviewed again (Jev approvals are not cached); file tools not reviewed')
    assert.equal(reviews[0]!.action.toolName, 'bash')
    assert.match(String(reviews[0]!.action.execution), /in the sandbox/)
    assert.match(JSON.stringify(reviews[0]!.transcript), /tidy up the util module/)
  } finally {
    h.cleanup()
  }
})

test('your deny rule wins over everything, catches compound commands, and explains itself; Jev is never asked', async () => {
  const h = makeHome(server, { runwayConfig: { permissions: [{ action: 'deny', command: 'git push --force*', reason: 'we never force-push' }] } })
  try {
    const before = server.jevRequests.length
    server.setScript(sequence([{ tool: 'bash', args: { command: 'echo ok && git push --force origin main' } }]))
    const r = await runPrint(h, 'ship')
    assert.ok(r.toolResults[0]!.isError)
    assert.match(r.toolResults[0]!.text, /Blocked by a rule in your Runway settings: deny bash · command "git push --force\*" — we never force-push/)
    assert.doesNotMatch(r.toolResults[0]!.text, /^ok/m, 'nothing ran')
    assert.equal(reviewsSince(before).length, 0)
  } finally {
    h.cleanup()
  }
})

test('allow rules skip review; ask rules ask you; a project cannot loosen your policy', async () => {
  const h = makeHome(server, { runwayConfig: { permissions: [{ action: 'allow', command: 'node --test*' }, { action: 'ask', command: 'git commit*' }] } })
  try {
    mkdirSync(join(h.project, '.pi'), { recursive: true })
    writeFileSync(join(h.project, '.pi', 'runway.json'), JSON.stringify({ permissions: [{ action: 'allow', tool: '*' }, { action: 'deny', command: 'rm -rf*' }] }))
    const before = server.jevRequests.length
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'node --test' } },
      { tool: 'bash', args: { command: 'git commit --allow-empty -qm x && echo committed' } },
      { tool: 'bash', args: { command: 'rm -rf build' } },
      { tool: 'bash', args: { command: 'echo reviewed' } },
    ]))
    const shown: string[] = []
    const r = await runRpc(h, ['go'], req => {
      shown.push(String(req.title))
      return { value: 'Allow once' }
    })
    assert.match(r.toolResults[0]!.text, /duration_ms|pass|fail/, 'node --test ran by your rule')
    assert.equal(shown.length, 1)
    assert.match(shown[0]!, /Your rule asks first: bash · command "git commit\*"/)
    assert.match(r.toolResults[1]!.text, /committed/)
    assert.ok(r.toolResults[2]!.isError)
    assert.match(r.toolResults[2]!.text, /project's Runway settings: deny/)
    assert.deepEqual(reviewsSince(before).map(j => j.action.command), ['echo reviewed'], "the project's `allow *` was ignored: the last command still went to Jev")
    const notices = r.events.filter(e => e.method === 'notify').map(e => String(e.message)).join('\n')
    assert.match(notices, /a project can only add "deny" or "ask" rules/)
  } finally {
    h.cleanup()
  }
})

test('approval choices: session approval sticks, "Always allow" saves a rule, a reason reaches the agent', async () => {
  const h = makeHome(server)
  try {
    server.setJev(() => ({ allow: false }))
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'echo first' } },
      { tool: 'bash', args: { command: 'echo first' } },
      { tool: 'bash', args: { command: 'npm run build' } },
      { tool: 'bash', args: { command: 'curl -s https://example.invalid/upload' } },
    ]))
    const answers = ['Allow for this session', 'Always allow…', 'Deny and tell the agent why…']
    const titles: string[] = []
    const r = await runRpc(h, ['go'], req => {
      titles.push(String(req.title))
      if (req.method === 'input') return { value: 'use the local mirror instead' }
      const options = req.options as string[]
      if (String(req.title).startsWith('Always allow')) return { value: options[0] }
      const want = answers.shift()
      if (want === undefined) return { value: options[0] }
      return { value: options.find(o => o.startsWith(want)) }
    })
    assert.equal(r.toolResults[0]!.isError, false)
    assert.equal(r.toolResults[1]!.isError, false, 'second identical call: approved for the session, no new dialog')
    assert.match(titles[0]!, /Jev said no/)
    assert.equal(titles.filter(t => t.includes('echo first')).length, 1)
    // "Always allow…" opened a second choice: the exact command first.
    assert.match(titles.find(t => t.startsWith('Always allow'))!, /save which rule/)
    const saved = JSON.parse(readFileSync(join(h.agentDir, 'runway.json'), 'utf8'))
    assert.deepEqual(saved.permissions[0], { action: 'allow', tool: 'bash', command: 'npm run build' })
    assert.ok(r.toolResults[3]!.isError)
    assert.match(r.toolResults[3]!.text, /use the local mirror instead/)
  } finally {
    h.cleanup()
  }
})

test('sandbox access is explicit: scoped write access, hosts approved with their command, and escalation stated as full access', async () => {
  const h = makeHome(server)
  try {
    server.setJev(() => ({ allow: true }))
    const sibling = join(h.home, 'code', 'sibling')
    mkdirSync(sibling, { recursive: true })
    server.setScript(sequence([
      { tool: 'bash', args: { command: `echo nope > ${sibling}/a.txt` } },
      { tool: 'bash', args: { command: `echo yes > ${sibling}/a.txt && cat ${sibling}/a.txt`, access: { write: [sibling] }, justification: 'the task updates the sibling repo' } },
      { tool: 'bash', args: { command: 'curl -sS -m 5 -o /dev/null https://approved-with-command.invalid/ 2>&1; echo code=$?' } },
      { tool: 'bash', args: { command: 'echo "canary=[$RUNWAY_TEST_API_TOKEN]" > ../escalated.txt; cat ../escalated.txt', escalate: true, justification: 'needs to write next to the project' } },
    ]))
    const before = server.jevRequests.length
    const r = await runRpc(h, ['go'])
    assert.ok(r.toolResults[0]!.isError, 'no write outside the project without access')
    assert.match(r.toolResults[1]!.text, /yes/)
    assert.doesNotMatch(r.toolResults[2]!.text, /403/, 'a host named in an approved command needs no second review')
    assert.match(r.toolResults[3]!.text, /canary=\[\]/, 'Jev-approved escalation runs outside the sandbox without secrets')
    assert.ok(existsSync(join(h.project, '..', 'escalated.txt')))
    const reviews = reviewsSince(before)
    assert.equal(reviews.length, 4, 'one review per command, none for the network')
    assert.match(String(reviews[1]!.action.execution), /plus write access to/)
    assert.deepEqual((reviews[1]!.action.requestedAccess as { write: string[] }).write, [sibling])
    assert.match(String(reviews[3]!.action.execution), /OUTSIDE the sandbox/)
    assert.equal(reviews[3]!.action.agentJustification, 'needs to write next to the project')
  } finally {
    h.cleanup()
  }
})

test('a person-approved escalation keeps the environment; Jev-approved does not', async () => {
  const h = makeHome(server)
  try {
    server.setJev(() => ({ allow: false }))
    server.setScript(sequence([{ tool: 'bash', args: { command: 'echo "canary=[$RUNWAY_TEST_API_TOKEN]"', escalate: true, justification: 'needs my token' } }]))
    const r = await runRpc(h, ['go'], req => {
      assert.match(String(req.title), /OUTSIDE the sandbox/)
      return { value: 'Allow once' }
    })
    assert.match(r.toolResults[0]!.text, new RegExp(`canary=\\[${ENV_CANARY}\\]`))
  } finally {
    h.cleanup()
  }
})

test('network: a host the command did not name is reviewed separately; a refusal shows as a 403', async () => {
  const h = makeHome(server)
  try {
    server.setJev(state => ({ allow: state.action.kind !== 'network' }))
    // The URL lives in a curl config file, so the command itself names no host.
    writeFileSync(join(h.project, 'fetch.curlrc'), 'url = "https://hidden-host.invalid/"\n')
    server.setScript(sequence([{ tool: 'bash', args: { command: 'curl -sS -m 5 -o /dev/null -w "%{http_code}" -x "$HTTPS_PROXY" https://hidden-host.invalid/ ; echo' } }]))
    const before = server.jevRequests.length
    const r = await runPrint(h, 'go')
    const reviews = reviewsSince(before)
    void r
    // The command names the host, so it is approved with the command: no separate review.
    assert.equal(reviews.filter(j => j.action.kind === 'network').length, 0)
    server.setScript(sequence([{ tool: 'bash', args: { command: 'curl -sS -m 5 -o /dev/null -K fetch.curlrc 2>&1; echo code=$?' } }]))
    const before2 = server.jevRequests.length
    const r2 = await runPrint(h, 'go')
    const net = reviewsSince(before2).filter(j => j.action.kind === 'network')
    assert.equal(net.length, 1)
    assert.equal(net[0]!.action.target, 'hidden-host.invalid')
    assert.deepEqual((net[0]!.action.input as { commands: string[] }).commands, ['curl -sS -m 5 -o /dev/null -K fetch.curlrc 2>&1; echo code=$?'], 'the review sees which command asked')
    assert.match(r2.toolResults[0]!.text, /403|error|status 403/)
  } finally {
    h.cleanup()
  }
})

test('network: your host rules apply to every connection, even to well-known hosts; a rule-allowed command does not carry its hosts', async () => {
  const h = makeHome(server, {
    runwayConfig: {
      permissions: [
        { action: 'deny', host: 'registry.npmjs.org', reason: 'use the company mirror' },
        { action: 'allow', command: 'curl -sS -m 5 -o /dev/null https://named-by-rule.invalid/*' },
        { action: 'allow', command: 'echo code=*' },
      ],
    },
  })
  try {
    server.setJev(state => ({ allow: state.action.kind !== 'network' }))
    // registry.npmjs.org is on Runway's known-hosts list; the URL is in a config file, so only the connection names it.
    writeFileSync(join(h.project, 'npm.curlrc'), 'url = "https://registry.npmjs.org/"\n')
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'curl -sS -m 5 -o /dev/null -K npm.curlrc 2>&1; echo code=$?' } },
      { tool: 'bash', args: { command: 'curl -sS -m 5 -o /dev/null https://named-by-rule.invalid/x 2>&1; echo code=$?' } },
    ]))
    const before = server.jevRequests.length
    const r = await runPrint(h, 'go')
    const reviews = reviewsSince(before)
    assert.match(r.toolResults[0]!.text, /403|CONNECT|code=(5|7|35|56)/, r.toolResults[0]!.text)
    assert.doesNotMatch(r.toolResults[0]!.text, /code=0/, 'the denied known host was not reached')
    assert.ok(!reviews.some(j => j.action.target === 'registry.npmjs.org'), 'your deny settles it; Jev is not asked')
    assert.equal(reviews.filter(j => j.action.toolName === 'bash').length, 1, 'the rule-allowed command is not reviewed')
    const net = reviews.filter(j => j.action.kind === 'network')
    assert.deepEqual(net.map(j => j.action.target), ['named-by-rule.invalid'], 'but its connection is: a rule about a command is not network access')
    assert.match(r.toolResults[1]!.text, /403|CONNECT|code=(5|7|35|56)/)
  } finally {
    h.cleanup()
  }
})

test('network: open mode still enforces your host rules; an explicit auto rule reviews even a well-known host', async () => {
  const h = makeHome(server, { runwayConfig: { network: 'open', permissions: [{ action: 'deny', host: 'blocked.invalid' }, { action: 'auto', host: 'registry.npmjs.org' }] } })
  try {
    server.setJev(state => ({ allow: state.action.kind !== 'network' }))
    writeFileSync(join(h.project, 'blocked.curlrc'), 'url = "https://blocked.invalid/"\n')
    writeFileSync(join(h.project, 'npm.curlrc'), 'url = "https://registry.npmjs.org/"\n')
    writeFileSync(join(h.project, 'any.curlrc'), 'url = "https://anything-else.invalid/"\n')
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'curl -sS -m 5 -o /dev/null -K blocked.curlrc 2>&1; echo code=$?' } },
      { tool: 'bash', args: { command: 'curl -sS -m 5 -o /dev/null -K npm.curlrc 2>&1; echo code=$?' } },
      { tool: 'bash', args: { command: 'curl -sS -m 5 -o /dev/null -K any.curlrc 2>&1; echo code=$?' } },
    ]))
    const before = server.jevRequests.length
    const r = await runPrint(h, 'go')
    const net = reviewsSince(before).filter(j => j.action.kind === 'network')
    assert.match(r.toolResults[0]!.text, /403/, `open mode, hidden host, your deny: ${r.toolResults[0]!.text}`)
    assert.deepEqual(net.map(j => j.action.target), ['registry.npmjs.org'], 'only the auto-ruled known host was reviewed')
    assert.match(r.toolResults[1]!.text, /403/, 'Jev said no to it')
    assert.doesNotMatch(r.toolResults[2]!.text, /403/, 'open mode lets any other host through without review')
  } finally {
    h.cleanup()
  }
})

test('without a reviewer key you decide; headless with nobody to ask blocks', async () => {
  const h = makeHome(server, { reviewerKey: false })
  try {
    const before = server.jevRequests.length
    server.setScript(sequence([{ tool: 'bash', args: { command: 'echo hi' } }]))
    const r = await runRpc(h, ['go'], req => {
      assert.match(String(req.title), /No reviewer is set up/)
      return { value: 'Allow once' }
    })
    assert.equal(r.toolResults[0]!.isError, false)
    const p = await runPrint(h, 'go')
    assert.ok(p.toolResults[0]!.isError)
    assert.match(p.toolResults[0]!.text, /no reviewer key is configured, and nobody is available to ask/)
    assert.equal(server.jevRequests.length, before)
    const status = r.events.find(e => e.method === 'setStatus' && e.statusKey === 'runway')
    assert.match(String(status?.statusText), /runway · auto/)
  } finally {
    h.cleanup()
  }
})

test('session approvals belong to one session: a new session asks again, switching back to the first does not', async () => {
  const h = makeHome(server)
  try {
    server.setJev(() => ({ allow: false }))
    server.setScript(req => (req.messages.at(-1)?.role === 'tool' ? { text: 'done' } : { tool: 'bash', args: { command: 'echo scoped' } }))
    const titles: string[] = []
    const firstFile = (events: PiEvent[]) => String((events.find(e => e.type === 'response' && e.command === 'get_state') as { data?: { sessionFile?: string } } | undefined)?.data?.sessionFile)
    const r = await runRpc(h, [
      'one',
      { rpc: { type: 'get_state' } },
      { rpc: { type: 'new_session' } },
      'two',
      events => ({ rpc: { type: 'switch_session', sessionPath: firstFile(events) } }),
      'three',
    ], req => {
      titles.push(String(req.title))
      return { value: (req.options as string[]).find(o => o.startsWith('Allow for this session')) }
    })
    assert.equal(titles.length, 2, `asked in the first session and again in the new one, not after switching back (${titles.length})`)
    assert.equal(r.toolResults.filter(t => !t.isError && /scoped/.test(t.text)).length, 3)
  } finally {
    h.cleanup()
  }
})

test('off: no sandbox and no reviews (explicit only)', async () => {
  const h = makeHome(server, { runwayConfig: { mode: 'off' } })
  try {
    const before = server.jevRequests.length
    server.setScript(sequence([{ tool: 'bash', args: { command: 'echo x > ../off.txt && echo "c=[$RUNWAY_TEST_API_TOKEN]"' } }]))
    const r = await runPrint(h, 'go')
    assert.equal(r.toolResults[0]!.isError, false)
    assert.match(r.toolResults[0]!.text, new RegExp(ENV_CANARY))
    assert.equal(server.jevRequests.length, before)
  } finally {
    h.cleanup()
  }
})

void dialogs
