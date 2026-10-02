import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { makeHome, runRpc, startFakeServer } from '../support/harness.ts'
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
    assert.match(text, /pi-permission-system is installed/)
    assert.match(text, /Runway auto — sandboxed; Jev reviews/)
    assert.match(text, /Runway ask — sandboxed; you review/)
    assert.match(text, /nothing has left the sandbox yet/)
  } finally {
    h.cleanup()
  }
})
