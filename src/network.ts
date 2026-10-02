import type { RunwayConfig } from './config.ts'
import { endpointCovers, parseHostPort } from './permissions/operation.ts'
import type { Endpoint, Operation } from './permissions/operation.ts'
import { matchHost, strongestMatch } from './permissions/rules.ts'
import type { Policy } from './policy.ts'

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
