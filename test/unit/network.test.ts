import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import type { RunwayConfig } from '../../src/config.ts'
import { createNetworkAsk } from '../../src/network.ts'
import type { Operation } from '../../src/permissions/operation.ts'
import { parseRules } from '../../src/permissions/rules.ts'
import { buildPolicy } from '../../src/policy.ts'
import { Runtime } from '../../src/runtime.ts'

// The proxy's connection callback, wired as index.ts wires it, with the
// reviewer replaced by promises the test settles: every interleaving of
// commands finishing, sessions ending and settings changing is deterministic.

const base = join(import.meta.dirname, '..', '..', '.e2e')
mkdirSync(base, { recursive: true })
const root = realpathSync(mkdtempSync(join(base, 'net-')))
after(() => rmSync(root, { recursive: true, force: true }))
const agentDir = join(homedir(), '.pi', 'agent')

interface Pending { op: Operation; session: string; settle: (allow: boolean) => void }

function world() {
  const rt = new Runtime(SandboxManager)
  const configs = new Map<string, RunwayConfig>()
  const reviews: Pending[] = []
  const ctxFor = (session: string) => ({ cwd: root, session }) as never
  const session = (id: string, config: Partial<RunwayConfig> = {}) => {
    configs.set(id, { ...DEFAULT_CONFIG, ...config } as RunwayConfig)
    rt.sessions.set(id, { id, ctx: ctxFor(id), hasUI: true })
  }
  const run = (id: string, sessionId: string, command = 'node fetch.js') => rt.running.set(id, { command, cwd: root, sessionId, endpoints: [] })
  const ask = createNetworkAsk({
    rt,
    settingsFor: ctx => ({ config: configs.get((ctx as unknown as { session: string }).session)!, off: false }),
    policyFor: (cwd, config) => buildPolicy(cwd, config, agentDir),
    review: (op, ctx) => new Promise<boolean>(settle => reviews.push({ op, session: (ctx as unknown as { session: string }).session, settle })),
  })
  const rules = (list: unknown[]) => parseRules(list, 'personal', 't', [])
  return { rt, configs, reviews, session, run, ask, rules }
}

const tick = () => new Promise(r => setImmediate(r))
// A wrong algorithm can wait forever on a review it never asked for: fail instead of hanging.
const T = { timeout: 3000 }

test('a command that finishes while another is reviewed still had its say: its deny holds', T, async () => {
  const w = world()
  w.session('a')
  w.session('b', { permissions: w.rules([{ action: 'deny', host: 'x.example' }]) })
  w.run('A', 'a')
  w.run('B', 'b')
  const answer = w.ask('x.example', 443)
  await tick()
  w.rt.running.delete('B') // B finishes; its background process could be the requester
  for (const r of w.reviews) r.settle(true)
  assert.equal(await answer, false)
})

test('a rule added while the review waits applies to the answer', T, async () => {
  const w = world()
  w.session('a')
  w.run('A', 'a')
  const answer = w.ask('x.example', 443)
  await tick()
  assert.equal(w.reviews.length, 1)
  w.configs.set('a', { ...w.configs.get('a')!, permissions: w.rules([{ action: 'deny', host: 'x.example', reason: 'changed my mind' }]) })
  w.reviews[0]!.settle(true)
  assert.equal(await answer, false)
})

test('a session that ended while its review waited gets no connection', T, async () => {
  const w = world()
  w.session('a')
  w.run('A', 'a')
  const answer = w.ask('x.example', 443)
  await tick()
  w.rt.sessions.delete('a')
  w.reviews[0]!.settle(true)
  assert.equal(await answer, false)
})

test('every running command is checked before anyone is asked; a restriction found first means no prompt at all', T, async () => {
  const w = world()
  w.session('a')
  w.session('b', { network: 'closed' })
  w.run('A', 'a')
  w.run('B', 'b')
  assert.equal(await w.ask('x.example', 443), false)
  assert.equal(w.reviews.length, 0, 'nobody was asked about a connection that would be refused anyway')
})

test('a command that starts after the connection arrived is not its requester', T, async () => {
  const w = world()
  w.session('a')
  w.session('c', { permissions: w.rules([{ action: 'deny', host: 'x.example' }]) })
  w.run('A', 'a')
  const answer = w.ask('x.example', 443)
  await tick()
  w.run('C', 'c')
  w.reviews[0]!.settle(true)
  assert.equal(await answer, true)
})

test('each running command needs its own yes, asked one at a time and once per command and host:port', T, async () => {
  const w = world()
  w.session('a')
  w.session('b')
  w.run('A', 'a')
  w.run('B', 'b')
  const first = w.ask('x.example', 443)
  const second = w.ask('x.example', 443)
  await tick()
  assert.deepEqual(w.reviews.map(r => r.session), ['a'], 'one question at a time, shared by both connections')
  w.reviews[0]!.settle(true)
  await tick()
  await tick()
  assert.deepEqual(w.reviews.map(r => r.session), ['a', 'b'])
  w.reviews[1]!.settle(false)
  assert.deepEqual(await Promise.all([first, second]), [false, false], "b's no refuses the shared connection")
  const again = w.ask('x.example', 443)
  assert.equal(await again, false, 'decided answers are reused, not asked again')
  assert.equal(w.reviews.length, 2)
  const otherPort = w.ask('x.example', 22)
  await tick()
  assert.equal(w.reviews.length, 3, 'another port is another question')
  w.reviews[2]!.settle(false)
  assert.equal(await otherPort, false)
})

test('a requester that finished before it could be asked about gets only what needs no asking', T, async () => {
  const w = world()
  w.session('a')
  w.session('b')
  w.run('A', 'a')
  w.run('B', 'b')
  const answer = w.ask('x.example', 443)
  await tick()
  w.rt.running.delete('B')
  w.reviews[0]!.settle(true)
  assert.equal(await answer, false, "nobody can be asked on the finished command's behalf")
  assert.equal(w.reviews.length, 1)
})

test('fast paths and explicit rules keep their meaning', T, async () => {
  const w = world()
  w.session('a', { allowHosts: ['api.example.dev:443'] })
  w.run('A', 'a')
  assert.equal(await w.ask('registry.npmjs.org', 443), true, 'known host')
  assert.equal(await w.ask('api.example.dev', 443), true, 'known host:port')
  const other = w.ask('api.example.dev', 22)
  await tick()
  assert.equal(w.reviews.length, 1, 'the port allowHosts named is the only one it covers')
  w.reviews[0]!.settle(false)
  assert.equal(await other, false)
  w.configs.set('a', { ...w.configs.get('a')!, permissions: w.rules([{ action: 'auto', host: 'registry.npmjs.org' }]) })
  const reviewed = w.ask('registry.npmjs.org', 443)
  await tick()
  assert.equal(w.reviews.length, 2, 'an explicit auto rule is reviewed even for a known host')
  w.reviews[1]!.settle(true)
  assert.equal(await reviewed, true)
  w.configs.set('a', { ...DEFAULT_CONFIG, network: 'open' } as RunwayConfig)
  assert.equal(await w.ask('anything.example', 443), true, 'open mode')
  w.configs.set('a', { ...DEFAULT_CONFIG, network: 'open', permissions: w.rules([{ action: 'deny', host: 'anything.example' }]) } as RunwayConfig)
  assert.equal(await w.ask('anything.example', 443), false, 'open mode keeps your deny')
})

test('with no command running, only what every session allows without asking', T, async () => {
  const w = world()
  w.session('a')
  assert.equal(await w.ask('registry.npmjs.org', 443), true)
  assert.equal(await w.ask('x.example', 443), false)
  assert.equal(w.reviews.length, 0)
})

test('an approval only holds under the settings it was given under: an ask rule added afterwards asks again', T, async () => {
  const w = world()
  w.session('a')
  w.run('A', 'a')
  const first = w.ask('x.example', 443)
  await tick()
  w.reviews[0]!.settle(true)
  assert.equal(await first, true)
  w.configs.set('a', { ...DEFAULT_CONFIG, permissions: w.rules([{ action: 'ask', host: 'x.example' }]) } as RunwayConfig)
  const second = w.ask('x.example', 443)
  await tick()
  assert.equal(w.reviews.length, 2, 'the new ask rule gets its question')
  w.reviews[1]!.settle(false)
  assert.equal(await second, false)
})

test('an auto rule added while a review is in flight: the old answer is not stamped as approved under the new settings', T, async () => {
  const w = world()
  w.session('a')
  w.run('A', 'a')
  const answer = w.ask('x.example', 443)
  await tick()
  w.configs.set('a', { ...DEFAULT_CONFIG, permissions: w.rules([{ action: 'auto', host: 'x.example' }]) } as RunwayConfig)
  const joining = w.ask('x.example', 443)
  await tick()
  assert.equal(w.reviews.length, 2, 'a connection under the new settings does not join the old question')
  w.reviews[0]!.settle(true)
  await tick()
  w.reviews[1]!.settle(false)
  assert.equal(await answer, false, 'the first answer was given under settings that no longer apply; the current review said no')
  assert.equal(await joining, false)
  assert.equal(w.reviews.length, 2)
})

test('unchanged settings: still one question per command and host:port', T, async () => {
  const w = world()
  w.session('a')
  w.run('A', 'a')
  const first = w.ask('x.example', 443)
  await tick()
  w.reviews[0]!.settle(true)
  assert.equal(await first, true)
  assert.equal(await w.ask('x.example', 443), true)
  assert.equal(w.reviews.length, 1)
})

test('policies are cached per folder and settings: new settings never get an old policy', async () => {
  const { policyCache } = await import('../../src/policy.ts')
  let built = 0
  const cached = policyCache((cwd, config) => {
    built += 1
    return buildPolicy(cwd, config, agentDir)
  })
  const one = { ...DEFAULT_CONFIG } as RunwayConfig
  cached(root, one)
  cached(root, one)
  assert.equal(built, 1)
  const two = { ...DEFAULT_CONFIG, allowHosts: ['api.example.dev'] } as RunwayConfig
  assert.ok(cached(root, two).allowHosts.includes('api.example.dev'), 'changed settings take effect at once')
  assert.equal(built, 2)
})
