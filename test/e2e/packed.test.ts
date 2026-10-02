import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { makeHome, PI_BIN, READ_BLOCKED, runRpc, SECRET_CANARY, sequence, startFakeServer } from '../support/harness.ts'
import type { FakeServer, PiEvent } from '../support/harness.ts'

// The package as users get it: `pi install npm:pi-runway` from a registry,
// used, then `pi update --extensions` to a newer version.
//
// Needs a throwaway registry on this machine that already serves the packed
// version (npm pack; npm publish <tgz> --registry <local>), plus a second,
// newer tarball this test publishes there mid-run:
//   RUNWAY_TEST_REGISTRY=http://127.0.0.1:4873/ RUNWAY_NEXT_TGZ=/abs/pi-runway-0.1.1.tgz
// The registry must be on localhost: this test never publishes anywhere else.

const REGISTRY = process.env.RUNWAY_TEST_REGISTRY
const NEXT = process.env.RUNWAY_NEXT_TGZ
const local = REGISTRY ? /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/$/.test(REGISTRY) : false

let server: FakeServer
before(async () => {
  server = await startFakeServer()
})
after(async () => {
  await server.close()
})

const notices = (events: PiEvent[]) => events.filter(e => e.type === 'extension_ui_request' && e.method === 'notify').map(e => String(e.message))
const installedVersion = (agentDir: string) => (JSON.parse(readFileSync(join(agentDir, 'npm', 'node_modules', 'pi-runway', 'package.json'), 'utf8')) as { version: string }).version

test('published package: pi install, doctor, contained work, pi update to a newer version', { skip: !(local && NEXT) && 'set RUNWAY_TEST_REGISTRY (localhost) and RUNWAY_NEXT_TGZ', timeout: 900_000 }, async () => {
  const h = makeHome(server)
  try {
    const settingsPath = join(h.agentDir, 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { packages: unknown[] }
    settings.packages = []
    writeFileSync(settingsPath, JSON.stringify(settings))
    // prefer-online: npm would otherwise answer "what's the latest version?" from its minutes-old cache.
    // The other tests run Pi offline; installing and updating need the (local) registry.
    const env = { ...h.env, PI_OFFLINE: undefined, npm_config_registry: REGISTRY, npm_config_cache: join(h.root, 'npm-cache'), npm_config_prefer_online: 'true' }
    const run = (bin: string, args: string[]) => execFileSync(bin, args, { cwd: h.project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 })

    assert.match(run(PI_BIN, ['install', 'npm:pi-runway']), /Installed/)
    const first = installedVersion(h.agentDir)
    const installed = join(h.agentDir, 'npm', 'node_modules', 'pi-runway')
    for (const dep of ['@gotgenes/pi-subagents', '@narumitw/pi-plan-mode', 'pi-web-access']) {
      assert.ok(existsSync(join(installed, 'node_modules', dep, 'package.json')), `${dep} came with the package`)
    }
    assert.ok(!existsSync(join(installed, 'node_modules', '@earendil-works', 'pi-coding-agent')), "Pi's own packages are never bundled")

    server.setJev(() => ({ allow: true }))
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'cat ~/.ssh/id_ed25519' } },
      { tool: 'bash', args: { command: 'echo packed > made-by-packed.txt && cat made-by-packed.txt' } },
    ]))
    const r = await runRpc(h, ['/runway doctor', 'go'], () => ({ cancelled: true }), 180_000)
    const text = notices(r.events).join('\n')
    assert.match(text, /Sandbox ready/, `${text}\n--- stderr:\n${r.stderr.slice(-3000)}`)
    assert.match(text, /Runway runs the bash tool/)
    assert.match(text, /Subagents: bundled @gotgenes\/pi-subagents@/)
    assert.match(text, /Plan mode: bundled @narumitw\/pi-plan-mode@/)
    assert.match(text, /Web search and fetch: bundled pi-web-access@/)
    assert.match(r.toolResults[0]!.text, READ_BLOCKED)
    assert.ok(!JSON.stringify(r.events).includes(SECRET_CANARY))
    assert.match(r.toolResults[1]!.text, /packed/)
    assert.ok(existsSync(join(h.project, 'made-by-packed.txt')))

    // A new release appears; one command moves to it, nothing is pinned.
    run('npm', ['publish', NEXT!, '--registry', REGISTRY!, `--${REGISTRY!.replace(/^http:/, '')}:_authToken=local-only`])
    run(PI_BIN, ['update', '--extensions'])
    const second = installedVersion(h.agentDir)
    assert.notEqual(second, first, `updated from ${first}`)
    const again = await runRpc(h, ['/runway doctor'], () => ({ cancelled: true }), 180_000)
    assert.match(notices(again.events).join('\n'), /Runway runs the bash tool/)
  } finally {
    h.cleanup()
  }
})
