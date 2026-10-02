import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { RunwayConfig } from './config.ts'
import { endpointCovers, networkOperation, parseHostPort } from './permissions/operation.ts'
import type { Endpoint, Operation } from './permissions/operation.ts'
import { matchHost, strongestMatch } from './permissions/rules.ts'
import type { Policy } from './policy.ts'
import type { NetworkAsk, RunningCommand, Runtime } from './runtime.ts'

// What a connection out of the sandbox may do, before anyone is asked.
// The proxy sends every connection here in every network mode, so:
//   1. "closed": a host that isn't known → no, never reviewed;
//   2. your rule for the host: deny → no; allow → yes; ask or auto → the gate
//      decides for the command that is running (you, or Jev);
//   3. no rule: a known host (Runway's list and your allowHosts, with any port
//      they name), a host:port approved with the command, or any host in
//      "open" mode → yes;
//   4. otherwise the gate decides.

export type ConnectionVerdict = 'allow' | 'deny' | 'gate'

export function knownHost(policy: Policy, host: string, port: number | undefined): boolean {
  return policy.allowHosts.some(entry => {
    const { host: pattern, port: only } = parseHostPort(entry)
    return matchHost(pattern, host) && (only === undefined || only === port)
  })
}

export function connectionVerdict(op: Operation, config: RunwayConfig, policy: Policy, approved: readonly Endpoint[]): ConnectionVerdict {
  const host = op.hosts[0]!
  const port = op.endpoints[0]?.port
  const known = knownHost(policy, host, port)
  if (config.network === 'closed' && !known) return 'deny'
  const yours = strongestMatch(config.permissions, op, { policy })
  if (yours?.action === 'deny') return 'deny'
  if (yours?.action === 'allow') return 'allow'
  if (yours) return 'gate'
  if (known || config.network === 'open' || approved.some(e => endpointCovers(e, host, port))) return 'allow'
  return 'gate'
}

/**
 * A connection while no command is running (something an earlier command
 * left behind). Nobody can be asked on its behalf, so only what this session
 * would let through without asking anyone.
 */
export function backgroundVerdict(op: Operation, config: RunwayConfig, policy: Policy): boolean {
  return connectionVerdict(op, config, policy, []) === 'allow'
}

export interface NetworkDeps {
  rt: Pick<Runtime, 'running' | 'sessions'>
  /** A session's current settings, read fresh each time (they can change while a review waits). */
  settingsFor: (ctx: ExtensionContext) => { config: RunwayConfig; off: boolean }
  policyFor: (cwd: string, config: RunwayConfig) => Policy
  /** The gate's decision for one command's connection (Jev, or a person). */
  review: (op: Operation, ctx: ExtensionContext) => Promise<boolean>
}

/**
 * The proxy's callback: may this connection out of the sandbox go ahead?
 *
 * The proxy can't tell which command opened it, so the requesters are every
 * command running when it arrived (captured then: one that starts later
 * can't have opened it). Each must be allowed to reach host:port on its own:
 *  1. check them all without asking anyone; any "no" refuses at once;
 *  2. ask about the ones that need it, one at a time, stopping at the first no
 *     (each command and host:port is asked about once);
 *  3. a review can take a while, and meanwhile a session can end or settings
 *     change: check everyone again with what's current (an answer counts only
 *     under the settings it was given under), up to three rounds,
 *     and refuse if still unsettled. A captured command that has finished
 *     can't be asked about any more, so it gets only what needs no asking.
 * With no command running, the requester is something an earlier command
 * left behind; nobody can be asked for it (backgroundVerdict, every session).
 */
export function createNetworkAsk(d: NetworkDeps): NetworkAsk {
  const { rt } = d
  // An answer holds only under the settings it was given under: a session's
  // settings object is replaced whenever its rules change, so a decision made
  // before an ask, auto or deny rule appeared is never reused after it.
  type Settings = RunwayConfig
  const decided = new WeakMap<RunningCommand, Map<string, { allow: boolean; settings: Settings }>>()
  const asking = new WeakMap<RunningCommand, Map<string, { settings: Settings; answer: Promise<boolean> }>>()
  const isRunning = (r: RunningCommand) => [...rt.running.values()].includes(r)

  const check = (r: RunningCommand, host: string, port: number | undefined): 'allow' | 'deny' | 'ask' => {
    const session = rt.sessions.get(r.sessionId)
    if (!session) return 'deny'
    const { config, off } = d.settingsFor(session.ctx)
    if (off) return 'allow'
    const verdict = connectionVerdict(networkOperation(host, port, r.cwd, [r.command]), config, d.policyFor(r.cwd, config), r.endpoints)
    if (verdict !== 'gate') return verdict
    const earlier = decided.get(r)?.get(`${host}:${port ?? ''}`)
    if (earlier && earlier.settings === config) return earlier.allow ? 'allow' : 'deny'
    return isRunning(r) ? 'ask' : 'deny'
  }

  const ask = (r: RunningCommand, host: string, port: number | undefined): Promise<boolean> => {
    const session = rt.sessions.get(r.sessionId)
    if (!session) return Promise.resolve(false)
    const { config } = d.settingsFor(session.ctx)
    const key = `${host}:${port ?? ''}`
    const inFlight = asking.get(r) ?? new Map<string, { settings: Settings; answer: Promise<boolean> }>()
    asking.set(r, inFlight)
    const current = inFlight.get(key)
    // Join a question only if it was asked under the same settings.
    if (current && current.settings === config) return current.answer
    const entry = {
      settings: config,
      answer: d.review(networkOperation(host, port, r.cwd, [r.command]), session.ctx).then(allow => {
        const map = decided.get(r) ?? new Map<string, { allow: boolean; settings: Settings }>()
        map.set(key, { allow, settings: config })
        decided.set(r, map)
        return allow
      }),
    }
    entry.answer = entry.answer.finally(() => {
      if (inFlight.get(key) === entry) inFlight.delete(key)
    })
    inFlight.set(key, entry)
    return entry.answer
  }

  return async (host, port) => {
    const requesters = [...rt.running.values()]
    if (requesters.length === 0) {
      return rt.sessions.size > 0 && [...rt.sessions.values()].every(s => {
        const { config, off } = d.settingsFor(s.ctx)
        if (off) return true
        return backgroundVerdict(networkOperation(host, port, s.ctx.cwd, []), config, d.policyFor(s.ctx.cwd, config))
      })
    }
    for (let round = 0; round < 3; round += 1) {
      const verdicts = requesters.map(r => check(r, host, port))
      if (verdicts.includes('deny')) return false
      const toAsk = requesters.filter((_, i) => verdicts[i] === 'ask')
      if (toAsk.length === 0) return true
      for (const r of toAsk) {
        // Things move while earlier questions wait: look again right before asking.
        const now = check(r, host, port)
        if (now === 'deny') return false
        if (now === 'ask' && !(await ask(r, host, port))) return false
      }
    }
    return false
  }
}
