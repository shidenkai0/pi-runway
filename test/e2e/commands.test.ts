import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { makeHome, runPrint, runRpc, startFakeServer } from '../support/harness.ts'
import type { FakeServer } from '../support/harness.ts'

let server: FakeServer
before(async () => {
  server = await startFakeServer()
})
after(async () => {
  await server.close()
})

const notices = (events: { type: string; method?: unknown; message?: unknown }[]) =>
  events.filter(e => e.type === 'extension_ui_request' && e.method === 'notify').map(e => String(e.message))

test('/worktree creates a branch checkout next to the repo and moves the conversation there', async () => {
  const h = makeHome(server)
  try {
    let sawCwd = ''
    server.setScript(req => {
      const text = JSON.stringify(req.messages)
      const last = req.messages.at(-1)
      if (last?.role === 'user' && JSON.stringify(last.content).includes('where am i')) {
        sawCwd = text
        return { tool: 'bash', args: { command: 'pwd && git branch --show-current && echo wt > wt.txt && git add wt.txt && git commit -qm wt && echo committed' } }
      }
      return { text: 'ok' }
    })
    const r = await runRpc(h, ['hello', '/worktree feature-x', 'where am i'])
    const target = join(h.home, 'code', 'app-feature-x')
    assert.ok(existsSync(target), 'worktree created')
    assert.match(notices(r.events).join('\n'), /Now working in .*app-feature-x on branch feature-x/)
    const bash = r.toolResults.find(t => t.toolName === 'bash')
    assert.ok(bash, 'a command ran after switching')
    assert.equal(bash.isError, false, bash.text)
    assert.match(bash.text, /app-feature-x\nfeature-x\n/)
    assert.match(bash.text, /committed/)
    assert.match(sawCwd, /hello/, 'the conversation came along')
    assert.match(execFileSync('git', ['log', '--oneline', '-1', 'feature-x'], { cwd: h.project, encoding: 'utf8' }), /wt/)
    const bad = await runRpc(h, ['/worktree ../../evil'])
    assert.match(notices(bad.events).join('\n'), /Usage: \/worktree/)
  } finally {
    h.cleanup()
  }
})

test('/runway doctor explains the setup and flags conflicting packages', async () => {
  const h = makeHome(server)
  try {
    const settingsPath = join(h.agentDir, 'settings.json')
    const settings = JSON.parse(execFileSync('cat', [settingsPath], { encoding: 'utf8' }))
    settings.packages.push('npm:@gotgenes/pi-permission-system@33.0.3')
    // Listed but not installed: doctor reads settings, Pi reports it as missing; that is fine for this check.
    writeFileSync(settingsPath, JSON.stringify({ ...settings, packages: settings.packages }))
    const r = await runRpc(h, ['/runway doctor', '/runway', '/runway ask', '/runway log'])
    const text = notices(r.events).join('\n')
    assert.match(text, /Sandbox ready/)
    assert.match(text, /Runway runs the bash tool/)
    assert.match(text, /Reviewer key found/)
    assert.match(text, /pi-permission-system is also installed/)
    assert.match(text, /Subagents: bundled @gotgenes\/pi-subagents/)
    assert.match(text, /Plan mode: bundled/)
    assert.match(text, /Web search and fetch: bundled/)
    assert.match(text, /auto — your rules first, Jev reviews the rest/)
    assert.match(text, /Runway ask — your rules first, you review the rest/)
    assert.match(text, /nothing has needed a decision yet/)
  } finally {
    h.cleanup()
  }
})

test('sandbox off keeps review on, scrubs secrets, and re-enabling restores containment', async () => {
  const h = makeHome(server)
  try {
    const before = server.jevRequests.length
    server.setJev(() => ({ allow: true }))
    server.setScript(req => req.messages.at(-1)?.role === 'tool' ? { text: 'done' } : { tool: 'bash', args: { command: 'echo trial > ../outside.txt; echo "secret=[$RUNWAY_TEST_API_TOKEN]"' } })
    const r = await runRpc(h, ['/runway sandbox off', '/runway', 'try uncontained', '/runway sandbox on', 'try contained'], req => ({ confirmed: req.method === 'confirm' }))
    assert.equal(r.toolResults.length, 2)
    assert.ok(existsSync(join(h.project, '..', 'outside.txt')), 'explicitly uncontained execution can write outside')
    assert.match(r.toolResults[0]!.text, /secret=\[\]/, 'Jev approval does not disclose secret env')
    assert.match(r.toolResults[1]!.text, /Operation not permitted|Permission denied|Read-only file system/, 'containment restored')
    const reviews = server.jevRequests.slice(before)
    assert.equal(reviews.length, 2)
    assert.match(String(reviews[0]!.action.execution), /OUTSIDE the sandbox/)
    assert.match(String(reviews[1]!.action.execution), /in the sandbox/)
    assert.match(notices(r.events).join('\n'), /Sandbox.*off.*review/i)
    assert.ok(r.events.some(e => e.method === 'setStatus' && /sandbox off.*reviewed/.test(String(e.statusText))))
  } finally { h.cleanup() }
})

test('sandbox off cancellation changes nothing; a new session does not inherit an unrelated override', async () => {
  const h = makeHome(server)
  try {
    server.setJev(() => ({ allow: true }))
    server.setScript(req => req.messages.at(-1)?.role === 'tool' ? { text: 'done' } : { tool: 'bash', args: { command: 'echo trial > ../cancelled.txt' } })
    const cancelled = await runRpc(h, ['/runway sandbox off', 'go'])
    assert.ok(!existsSync(join(h.project, '..', 'cancelled.txt')))
    const r = await runRpc(h, ['/runway sandbox off', '/runway', { rpc: { type: 'new_session' } }, '/runway'], req => ({ confirmed: true }))
    const status = r.events.filter(e => e.method === 'setStatus').map(e => String(e.statusText))
    assert.ok(status.some(s => /sandbox off/.test(s)))
    assert.ok(!/sandbox off/.test(status.at(-1)!), 'new session starts contained')
    assert.match(cancelled.toolResults[0]!.text, /Operation not permitted|Permission denied|Read-only file system/)
  } finally { h.cleanup() }
})

test('startup sandbox-only flag retains rules and Jev, including failures and human review', async () => {
  const h = makeHome(server, { piArgs: ['--no-sandbox'], runwayConfig: { permissions: [{ action: 'allow', command: 'echo *' }, { action: 'deny', command: 'echo denied*' }] } })
  try {
    server.setScript(req => req.messages.at(-1)?.role === 'tool' ? { text: 'done' } : { tool: 'bash', args: { command: JSON.stringify(req.messages.at(-1)?.content).includes('denied') ? 'echo denied' : 'echo "secret=[$RUNWAY_TEST_API_TOKEN]"' } })
    let before = server.jevRequests.length
    server.setJev(() => ({ allow: true }))
    const allowed = await runPrint(h, 'go')
    assert.equal(allowed.toolResults[0]?.isError, false, allowed.stderr)
    assert.match(allowed.toolResults[0]!.text, /secret=\[\]/)
    assert.equal(server.jevRequests.length, before + 1, 'ordinary sandboxed allow rule does not bypass review outside')
    assert.match(String(server.jevRequests.at(-1)!.action.execution), /OUTSIDE the sandbox/)
    before = server.jevRequests.length
    const denied = await runPrint(h, 'denied')
    assert.equal(denied.toolResults[0]?.isError, true)
    assert.equal(server.jevRequests.length, before, 'deny rule remains authoritative')
    server.setJev(() => ({ status: 500 }))
    const failure = await runPrint(h, 'go')
    assert.equal(failure.toolResults[0]?.isError, true, 'review failure cannot approve unsandboxed execution')
    const human = await runRpc(h, ['/runway ask', 'go'], req => ({ value: (req.options as string[] | undefined)?.find(o => o.startsWith('Allow once')) }))
    assert.equal(human.toolResults[0]?.isError, false)
    assert.ok(human.uiRequests.some(req => /OUTSIDE the sandbox/.test(String(req.title))))
  } finally { h.cleanup() }
})

test('sandbox-off UDP works with review still on (localhost-only test)', async () => {
  const receiver = createSocket('udp4')
  await new Promise<void>(resolve => receiver.bind(0, '127.0.0.1', resolve))
  let received = 0
  receiver.on('message', () => { received += 1 })
  const port = receiver.address().port
  const command = `node -e 'const d=require("node:dgram").createSocket("udp4"); d.send("runway-test",${port},"127.0.0.1",e=>{if(e){console.error(e.code+": "+e.message);process.exitCode=1;}else console.log("udp sent");d.close();});'`
  const direct = makeHome(server, { piArgs: ['--no-sandbox'] })
  try {
    server.setJev(() => ({ allow: true }))
    server.setScript(req => req.messages.at(-1)?.role === 'tool' ? { text: 'done' } : { tool: 'bash', args: { command } })
    // Localhost is deliberately reachable inside the macOS sandbox for dev
    // servers. This verifies direct UDP execution, not external-host isolation.
    const before = server.jevRequests.length
    const allowed = await runPrint(direct, 'send the test message to the local UDP receiver')
    assert.equal(allowed.toolResults[0]?.isError, false, allowed.stderr)
    assert.match(allowed.toolResults[0]!.text, /udp sent/)
    assert.equal(received, 1)
    assert.equal(server.jevRequests.length, before + 1)
    assert.match(String(server.jevRequests.at(-1)!.action.execution), /OUTSIDE the sandbox/)
  } finally {
    receiver.close()
    direct.cleanup()
  }
})
