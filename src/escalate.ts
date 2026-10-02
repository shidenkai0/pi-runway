import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Mode, RunwayConfig } from './config.ts'
import type { FloorHit } from './floor.ts'
import { askJev, ReviewerError, resolveReviewerKey } from './review/jev.ts'
import type { JevVerdict } from './review/jev.ts'
import { renderTranscriptForState } from './review/transcript.ts'
import type { Runtime } from './runtime.ts'

// One question, asked in one place: "this action wants to leave the sandbox —
// may it?" Floor hits go to a person. Everything else goes to Jev in auto
// mode, or to a person in ask mode. A person is found in this session's UI, or
// the parent session's UI when this is a subagent; with nobody to ask, the
// answer is no.

export type EscalationKind = 'command' | 'outward' | 'network' | 'read' | 'write' | 'search' | 'sandbox-unavailable'

export interface Escalation {
  kind: EscalationKind
  /** One line a person can read in a dialog. */
  title: string
  /** Why it left the sandbox (policy wording, shown to people and the reviewer). */
  reason: string
  command?: string
  justification?: string
  path?: string
  host?: string
  port?: number
  tool?: string
  cwd: string
  floor?: FloorHit
  /** What a session-wide approval would cover, if offered (a host, a folder). */
  sessionGrant?: { label: string; apply: () => void }
}

export type Decision =
  | { allow: true; by: 'reviewer' | 'person' | 'session-grant'; fullEnv: boolean }
  | { allow: false; by: 'reviewer' | 'person' | 'floor' | 'unavailable'; message: string }

export interface DecideContext {
  rt: Runtime
  config: RunwayConfig
  mode: Mode
  ctx: ExtensionContext
  sessionId: string
  /** The tool call's abort signal: Esc cancels a pending review or dialog. */
  signal?: AbortSignal
  /** Injected for tests. */
  fetchImpl?: typeof fetch
}

/** A connection waits while a person decides; don't hold it forever. */
const NETWORK_DIALOG_TIMEOUT_MS = 120_000

const FIRED_WORDS: Record<string, string> = {
  sensitive_egress: 'it could send sensitive data somewhere it does not belong',
  destructive: 'it could destroy data in a way that is hard to undo',
  credential_probing: 'it goes looking for credentials',
  security_weakening: 'it weakens a security setting',
}

export function explainVerdict(v: JevVerdict): string {
  if (v.why.startsWith('OWNER RULE')) return 'it would print a secret value into the conversation'
  if (v.why === 'critical risk') return 'the reviewer rated it critical risk'
  if (v.why.startsWith('malicious injection')) return 'it seems to follow instructions from files or tool output rather than from the user'
  if (v.why.startsWith('absolute deny:')) {
    const parts = v.why.slice('absolute deny:'.length).trim().split(',').map(k => FIRED_WORDS[k.trim()] ?? k.trim())
    return parts.join('; ')
  }
  if (v.why.startsWith('high risk without')) return 'it is high-risk and the user has not clearly asked for it'
  return v.why
}

function describeForReviewer(e: Escalation): Record<string, unknown> {
  const action: Record<string, unknown> = {
    source: 'pi-runway',
    request: e.kind === 'command'
      ? 'Run this shell command OUTSIDE the sandbox (full access to the machine, network, and files outside the project).'
      : e.kind === 'outward'
        ? 'Run this shell command inside the sandbox; it publishes, deploys or changes a remote, so its effect lands outside this machine.'
      : e.kind === 'network'
        ? 'Allow a sandboxed command to connect to a network host that is not on the allowlist, for the rest of the session.'
        : e.kind === 'read'
          ? 'Let the agent read a file that is protected as a secret or credential.'
          : e.kind === 'write'
            ? 'Let the agent write a file outside the project or into a protected location.'
            : e.kind === 'search'
              ? 'Let the agent search a folder that contains protected credential stores.'
              : 'Run this shell command without a sandbox (the sandbox is unavailable on this machine).',
    toolName: e.tool ?? (e.kind === 'network' ? 'network' : 'bash'),
    sandboxReason: e.reason,
    cwd: e.cwd,
  }
  if (e.command !== undefined) action.command = e.command
  if (e.justification) action.agentJustification = e.justification
  if (e.path !== undefined) action.path = e.path
  if (e.host !== undefined) action.target = e.port ? `${e.host}:${e.port}` : e.host
  return action
}

/** What "allow" actually grants, in one line, shown in every dialog. */
const BOUNDARY: Record<EscalationKind, string> = {
  command: 'If allowed, it runs outside the sandbox with your full user access (secret environment variables stay removed unless you allow it yourself).',
  'sandbox-unavailable': 'If allowed, it runs without any sandbox, with your full user access.',
  outward: 'If allowed, it runs inside the sandbox; whatever it publishes, deploys or pushes cannot be taken back by Runway.',
  network: 'If allowed, sandboxed commands can reach this host for the rest of the session.',
  read: 'If allowed, the file contents go into the conversation (and to your model provider).',
  write: 'If allowed, Pi writes this file directly, outside the sandbox rules.',
  search: 'If allowed, search results from this folder go into the conversation.',
}

async function askPerson(dc: DecideContext, e: Escalation, why: string): Promise<Decision | undefined> {
  const person = dc.rt.personFor(dc.sessionId)
  if (!person) return undefined
  const fromSubagent = person.id !== dc.sessionId
  return dc.rt.serialize(async () => {
    if (e.sessionGrant && e.kind === 'network' && dc.rt.grantedHosts.has(e.host ?? '')) return { allow: true, by: 'session-grant', fullEnv: false } as const
    const who = fromSubagent ? 'A subagent' : 'The agent'
    const lines = [
      e.kind === 'outward' ? `${who} wants to run a command whose effect lands outside this machine.` : `${who} wants to leave the sandbox.`,
      '',
      e.title,
      e.justification ? `Agent's reason: ${e.justification}` : undefined,
      `Why you are asked: ${why}`,
      BOUNDARY[e.kind],
    ].filter((l): l is string => l !== undefined)
    // A host is either reachable for this session or not; asking per connection would be noise.
    const options = e.kind === 'network' ? [] : ['Allow once']
    if (e.sessionGrant) options.push(`Allow ${e.sessionGrant.label} for this session`)
    options.push('Deny')
    let choice: string | undefined
    try {
      if (dc.signal?.aborted) return undefined
      choice = await person.ctx.ui.select(lines.join('\n'), options, {
        signal: dc.signal,
        timeout: e.kind === 'network' ? NETWORK_DIALOG_TIMEOUT_MS : undefined,
      })
    } catch {
      choice = undefined
    }
    if (choice === 'Allow once') return { allow: true, by: 'person', fullEnv: true } as const
    if (choice && choice.startsWith('Allow ') && e.sessionGrant) {
      e.sessionGrant.apply()
      return { allow: true, by: 'person', fullEnv: true } as const
    }
    return {
      allow: false,
      by: 'person',
      message: 'Blocked by Runway: the user declined this action. Do not retry it; continue another way or ask the user what they want.',
    } as const
  })
}

function nobodyToAsk(why: string, by: 'unavailable' | 'floor' = 'unavailable'): Decision {
  return {
    allow: false,
    by,
    message: `Blocked by Runway: this needs a person's approval (${why}), and no one is available to ask in this session. Do not retry; finish what you can inside the sandbox and report what still needs the user.`,
  }
}

export async function decide(dc: DecideContext, e: Escalation): Promise<Decision> {
  const { rt, config } = dc
  const summary = e.host ? `${e.host}${e.port ? `:${e.port}` : ''}` : e.command ?? e.path ?? e.title
  const log = (d: Decision, extra: { why?: string; latencyMs?: number; by?: string } = {}): Decision => {
    rt.record({
      session: dc.sessionId,
      kind: e.kind,
      summary,
      decision: d.allow ? 'allowed' : 'denied',
      by: (extra.by ?? (d.by === 'floor' ? 'floor' : d.by)) as never,
      why: extra.why ?? (d.allow ? undefined : d.message),
      latencyMs: extra.latencyMs,
    })
    return d
  }

  if (e.floor) {
    const why = `${e.floor.reason} (always asks a person)`
    const answer = await askPerson(dc, e, why)
    return log(answer ?? nobodyToAsk(why, 'floor'), { why })
  }

  if (dc.mode === 'ask') {
    const answer = await askPerson(dc, e, e.reason)
    return log(answer ?? nobodyToAsk(e.reason), { why: e.reason })
  }

  // auto: Jev decides.
  const personFallback = async (why: string): Promise<Decision> => {
    const answer = await askPerson(dc, e, why)
    return log(answer ?? nobodyToAsk(why), { why })
  }
  const key = await resolveReviewerKey(config.reviewer.route, dc.ctx.modelRegistry ?? {}, process.env, rt.agentDir)
  if (!key) return personFallback('no reviewer key is set up, so Runway cannot review automatically')
  if (rt.breaker.isCoolingDown()) return personFallback('the reviewer is unavailable right now')

  let verdict: JevVerdict
  try {
    const transcript = renderTranscriptForState(dc.ctx.sessionManager.getBranch() as never).entries
    verdict = await askJev({ action: describeForReviewer(e), transcript }, key, config.reviewer, { fetchImpl: dc.fetchImpl, signal: dc.signal })
    rt.breaker.recordSuccess()
  } catch (error) {
    if (error instanceof ReviewerError && error.kind === 'cancelled') {
      return log({ allow: false, by: 'unavailable', message: 'Cancelled.' }, { why: 'cancelled' })
    }
    rt.breaker.recordFailure()
    const detail = error instanceof Error ? error.message : String(error)
    return personFallback(`the reviewer could not decide (${detail})`)
  }

  const reason = explainVerdict(verdict)
  if (verdict.outcome === 'allow') {
    // A reviewed host stays reachable for the session; files and commands are approved one at a time.
    if (e.kind === 'network') e.sessionGrant?.apply()
    return log({ allow: true, by: 'reviewer', fullEnv: false }, { why: `${verdict.why}; risk ${verdict.risk}, authorization ${verdict.authorization}`, latencyMs: verdict.latencyMs })
  }
  if (config.onDeny === 'ask') {
    const answer = await askPerson(dc, e, `the reviewer said no: ${reason}`)
    if (answer) return log(answer, { why: `reviewer: ${reason}` })
  }
  return log(
    {
      allow: false,
      by: 'reviewer',
      message:
        `Blocked by Runway's safety reviewer: ${reason}. Do not retry the same action. ` +
        'If it is genuinely needed, explain to the user what you want to do and why, and ask them to confirm in chat; ' +
        'after they explicitly confirm, you may retry it once with a justification that quotes their confirmation.',
    },
    { why: `${verdict.why}; risk ${verdict.risk}, authorization ${verdict.authorization}`, latencyMs: verdict.latencyMs },
  )
}
