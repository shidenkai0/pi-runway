import { homedir } from 'node:os'
import { relative } from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Mode, RunwayConfig } from '../config.ts'
import { savePersonalRule } from '../config.ts'
import { isWithin } from '../policy.ts'
import type { Policy } from '../policy.ts'
import { askJev, ReviewerError, resolveReviewerKey } from '../review/jev.ts'
import type { JevVerdict } from '../review/jev.ts'
import { renderTranscriptForState } from '../review/transcript.ts'
import type { Runtime } from '../runtime.ts'
import { requestApproval } from '../ui/approval.ts'
import type { ApprovalChoice, Tone } from '../ui/approval.ts'
import { toolGrantable } from './operation.ts'
import type { Operation } from './operation.ts'
import { allowedPartByPart, defaultRules, describeRule, ruleMatches, strongestMatch, uncertainRestrictive } from './rules.ts'
import type { Rule } from './rules.ts'
import { saveScopes, sessionOpLabel } from './suggest.ts'
import type { Reviewer } from '../review/reviewer.ts'

// The one decision every tool call goes through.
//
//   1. your deny rule (project or personal)        → no, and the agent is told which rule
//   2. you allowed this exact operation this session → yes
//   3. a deny/ask command rule Runway can't settle  → ask you (the command builds what it runs at run time)
//   4. your ask rule                                → ask you
//   5. your allow rule                              → yes
//   6. a built-in "ask" safeguard                   → ask you (never the reviewer)
//   7. you allowed this whole tool this session     → yes (only for calls inside the normal sandbox)
//   8. your auto rule                               → reviewer
//   9. a built-in "allow" default                   → yes
//  10. anything else                                → reviewer (Jev), or you without one
//
// "Ask you" falls back to "no" when nobody is at a screen. When the reviewer
// says no or can't decide, you get the last word if you're there. Reviewer
// approvals are never reused: the same call later is judged again against
// the conversation as it is then.

export interface GateContext {
  rt: Runtime
  config: RunwayConfig
  policy: Policy
  mode: Mode
  /** The calling session's context (its transcript is what the reviewer reads). */
  ctx: ExtensionContext
  sessionId: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** Status updates while a review is running. */
  onProgress?: (text: string | undefined) => void
  /**
   * Replaying an eval case (eval/run.ts): its transcript instead of the
   * session's; for a historical case the recorded permission request as
   * evidence and what was never recorded; for a public case its working folder.
   */
  replay?: { transcript: object[]; recordedRequest?: Record<string, unknown>; notRecorded: string[]; cwd?: string }
  /** The evaluation's candidate reviewer (questions, policy, composer); production otherwise. */
  reviewer?: Reviewer
  /** Told every reviewer answer or failure, as structured data (eval/run.ts records them). */
  onReview?: (result: { verdict: JevVerdict } | { failure: string; latencyMs: number }) => void
}

export interface Verdict {
  allow: boolean
  by: 'rule' | 'grant' | 'default' | 'reviewer' | 'person' | 'mode' | 'unavailable'
  rule?: Rule
  /** The tool-result text the agent sees when the call is refused. */
  message?: string
  /** A person approved this exact call: the command keeps credential environment variables. */
  fullEnv: boolean
  /**
   * Whoever allowed it saw this exact call (the reviewer, a person, or a
   * person's grant for this exact operation), so hosts named in the command
   * count as approved. Rules and whole-tool grants don't widen the network.
   */
  sawCall: boolean
}

const FIRED_WORDS: Record<string, string> = {
  sensitive_egress: 'it could send sensitive data somewhere it does not belong',
  destructive: 'it could destroy data in a way that is hard to undo',
  credential_probing: 'it goes looking for credentials',
  security_weakening: 'it weakens a security setting',
}

export function explainVerdict(v: JevVerdict): string {
  if (v.why.startsWith('OWNER RULE')) return 'it would print a secret value into the conversation'
  if (v.why === 'critical risk') return 'it rated this critical risk'
  if (v.why === 'possible secret disclosure: confirm with the user') return 'it might put a secret value into the conversation, so the user should confirm'
  if (v.why === 'user prohibition still in effect') return 'the user said not to do this (or not to touch this) earlier in the conversation'
  if (v.why.startsWith('malicious injection')) return 'it seems to follow instructions from files or tool output rather than from the user'
  if (v.why.startsWith('absolute deny:')) return v.why.slice('absolute deny:'.length).trim().split(',').map(k => FIRED_WORDS[k.trim()] ?? k.trim()).join('; ')
  if (v.why.startsWith('high risk without')) return 'it is high-risk and the user has not clearly asked for it'
  return v.why
}

function short(path: string, workspace: string): string {
  if (isWithin(path, workspace) && path !== workspace) return relative(workspace, path)
  const home = homedir()
  return isWithin(path, home) ? `~/${relative(home, path)}` : path
}

/** How the operation will run, said plainly, with a tone for the dialog. */
export function describeExecution(op: Operation, policy: Policy): { text: string; tone: Tone } {
  switch (op.execution) {
    case 'sandboxed':
      return { text: 'in the sandbox: writes stay in the project, network to known hosts only', tone: 'normal' }
    case 'sandboxed-with-access': {
      const parts = [
        ...(op.access?.write.length ? [`write access to ${op.access.write.map(p => short(p, policy.workspace)).join(', ')}`] : []),
        ...(op.access?.hosts.length ? [`network access to ${op.access.hosts.join(', ')}`] : []),
      ]
      return { text: `in the sandbox, plus ${parts.join(' and ')} for this command`, tone: 'warning' }
    }
    case 'unsandboxed':
      return { text: 'OUTSIDE the sandbox, with your full access to files, credentials and network', tone: 'danger' }
    case 'in-process':
      if (op.kind === 'read' || op.kind === 'search') return { text: `by Pi itself (reads ${op.paths.map(p => short(p.path, policy.workspace)).join(', ')})`, tone: 'normal' }
      if (op.kind === 'write') return { text: `by Pi itself (writes ${op.paths.map(p => short(p.path, policy.workspace)).join(', ')})`, tone: op.paths.every(p => isWithin(p.path, policy.workspace)) ? 'normal' : 'warning' }
      if (op.kind === 'mcp') return { text: `by the ${op.mcp?.server ?? 'MCP'} server, outside the sandbox${op.meta.annotations?.readOnlyHint ? ' (it says it only reads)' : ''}`, tone: op.meta.annotations?.readOnlyHint ? 'normal' : 'warning' }
      if (op.kind === 'web') return { text: `by Pi from this computer${op.hosts.length ? `, contacting ${op.hosts.join(', ')}` : ''}`, tone: 'normal' }
      if (op.kind === 'codemode') return { text: 'as a script inside Pi: each tool it calls is checked on its own, but the script itself can also call models with your provider credentials', tone: 'warning' }
      return { text: `by the ${op.meta.source === 'unknown' ? 'tool' : `${op.meta.source} tool`} inside Pi, outside the sandbox`, tone: 'warning' }
  }
}

/** "run a command", "edit a file"… — the headline of the approval dialog. */
export function verbFor(op: Operation): string {
  switch (op.kind) {
    case 'shell':
      return op.execution === 'unsandboxed' ? 'run a command outside the sandbox' : 'run a command'
    case 'read':
      return 'read a file'
    case 'write':
      return op.tool === 'edit' ? 'edit a file' : 'write a file'
    case 'search':
      return 'search files'
    case 'mcp':
      return `use ${op.mcp?.server ?? 'an'} MCP tool`
    case 'web':
      return op.tool === 'fetch_content' ? 'fetch from the web' : 'search the web'
    case 'network':
      return 'connect to a new host'
    case 'subagent':
      return 'start a subagent'
    case 'codemode':
      return 'run a codemode script'
    default:
      return `use the ${op.tool} tool`
  }
}

function actionLines(op: Operation, policy: Policy): string[] {
  if (op.kind === 'shell' && op.command) return op.command.split('\n').map((l, i) => `${i === 0 ? '$ ' : '  '}${l}`)
  if (op.kind === 'read' || op.kind === 'write' || op.kind === 'search') {
    const verb = op.tool === 'edit' ? 'edit' : op.tool
    return [`${verb} ${op.paths.map(p => short(p.path, policy.workspace)).join(', ')}`]
  }
  if (op.kind === 'mcp' && op.mcp) return [`${op.mcp.server} / ${op.mcp.tool}`, ...jsonLines(op.input)]
  if (op.kind === 'network') return [op.summary, ...((op.input.commands as string[] | undefined)?.length ? [`for: ${(op.input.commands as string[])[0]}`] : [])]
  if (op.kind === 'web') return [op.summary, ...jsonLines(op.input)]
  if (op.kind === 'codemode' && typeof op.input.code === 'string') return op.input.code.split('\n')
  return [op.tool, ...jsonLines(op.input)]
}

// The dialog shows every line in full (it scrolls); nothing is cut here.
function jsonLines(input: Record<string, unknown>): string[] {
  const text = JSON.stringify(input, null, 2)
  if (text === '{}') return []
  return text.split('\n')
}

/** The most input the reviewer is sent. Bigger calls go to a person: the reviewer never judges a call it can only partly see. */
export const REVIEW_INPUT_LIMIT = 32_000

export function tooLargeToReview(op: Operation): boolean {
  return JSON.stringify(op.input).length > REVIEW_INPUT_LIMIT
}

/** What the reviewer is shown about the call. Values are redacted later, at the transport boundary. */
export function reviewerAction(op: Operation, g: GateContext): Record<string, unknown> {
  const exec = describeExecution(op, g.policy)
  const action: Record<string, unknown> = {
    source: 'pi-runway',
    toolName: op.tool,
    kind: op.kind,
    request: `The coding agent wants to call the tool "${op.tool}": ${op.summary}`,
    execution: exec.text,
    cwd: g.replay ? (g.replay.cwd ?? 'not recorded') : op.cwd,
    input: op.input,
    ...(g.replay?.recordedRequest ? { recordedRequest: g.replay.recordedRequest } : {}),
    ...(g.replay?.notRecorded.length ? { notRecorded: g.replay.notRecorded } : {}),
  }
  if (op.command) action.command = op.command
  if (op.shell?.opaque) action.cannotAnalyze = op.shell.opaqueReasons
  if (op.paths.length) action.paths = op.paths
  if (op.hosts.length) action.target = op.hosts.join(', ')
  if (op.access) action.requestedAccess = op.access
  if (op.mcp) action.mcp = { server: op.mcp.server, tool: op.mcp.tool, annotations: op.meta.annotations ?? {} }
  if (op.kind === 'codemode') action.note = 'A script the agent wrote. Each tool it calls is checked separately, but it can also call language models directly with the user\'s provider credentials, which is not checked separately.'
  if (op.parentToolCallId) action.calledFrom = 'a codemode script the agent wrote (each call inside it is reviewed separately)'
  if (g.rt.grants.parentOf(g.sessionId)) action.agentName = g.rt.agentNames.get(g.sessionId) ?? 'subagent'
  if (typeof op.input.justification === 'string') action.agentJustification = op.input.justification
  return action
}

function allow(by: Verdict['by'], extra: Partial<Verdict> = {}): Verdict {
  return { allow: true, by, fullEnv: false, sawCall: by === 'person' || by === 'reviewer', ...extra }
}

function refuse(by: Verdict['by'], message: string, extra: Partial<Verdict> = {}): Verdict {
  return { allow: false, by, message, fullEnv: false, sawCall: false, ...extra }
}

function ruleRefusal(rule: Rule): string {
  const where = rule.source === 'project' ? "the project's Runway settings" : 'your Runway settings'
  return `Blocked by a rule in ${where}: deny ${describeRule(rule)}${rule.reason ? ` — ${rule.reason}` : ''}. This is a standing rule, not a judgment call: do not retry it or work around it. Continue another way, or tell the user what you need.`
}

interface AskOptions {
  why: string
  whyTone: Tone
  focusDeny?: boolean
  /** Refusal text when nobody can be asked. */
  unattended: string
  /** Refusal text when the person says no without giving a reason. */
  declined?: string
}

async function askPerson(op: Operation, g: GateContext, o: AskOptions): Promise<Verdict> {
  const { rt } = g
  const person = rt.personFor(g.sessionId)
  if (!person) {
    rt.tally.for(g.sessionId).unattended += 1
    return refuse('unavailable', o.unattended)
  }
  const exec = describeExecution(op, g.policy)
  const choice: ApprovalChoice | undefined = await rt.serialize(() => {
    // Someone may have approved the same thing while this call waited its turn.
    if (rt.grants.findPersonGrant(g.sessionId, op, 'operation')) return Promise.resolve({ kind: 'once' } as ApprovalChoice)
    rt.stats.asked += 1
    // Counted for the session that asked, even when its parent's screen shows the dialog.
    rt.tally.for(g.sessionId).prompts += 1
    return requestApproval(person.ctx, {
      tool: op.mcp ? `${op.mcp.server} · MCP` : op.tool,
      who: rt.whoIs(g.sessionId),
      verb: verbFor(op),
      action: actionLines(op, g.policy),
      where: op.cwd !== g.policy.workspace ? short(op.cwd, g.policy.workspace) : undefined,
      why: o.why,
      whyTone: o.whyTone,
      runs: exec.text,
      runsTone: exec.tone,
      sessionOpLabel: sessionOpLabel(op),
      sessionToolLabel: !toolGrantable(op) ? undefined : `Allow every ${op.mcp ? `${op.mcp.server} / ${op.mcp.tool}` : op.tool} call this session`,
      saveScopes: saveScopes(op, g.policy.workspace),
      focusDeny: o.focusDeny,
      signal: g.signal,
      timeoutMs: op.kind === 'network' ? 120_000 : undefined,
    })
  })
  if (!choice) return refuse('unavailable', g.signal?.aborted ? 'Cancelled.' : o.unattended)
  switch (choice.kind) {
    case 'once':
      return allow('person', { fullEnv: true })
    case 'session-op':
      rt.grants.add(g.sessionId, { scope: 'operation', key: op.key, label: sessionOpLabel(op), tool: op.tool, by: 'person' })
      return allow('person', { fullEnv: true })
    case 'session-tool':
      rt.grants.add(g.sessionId, { scope: 'tool', key: op.tool, label: `every ${op.tool} call`, tool: op.tool, by: 'person' })
      return allow('person')
    case 'save': {
      try {
        const path = savePersonalRule(choice.scope.rule)
        rt.configGeneration += 1
        person.ctx.ui.notify(`Saved: allow ${describeRule({ ...choice.scope.rule, id: '', source: 'personal' })}  (${path})`, 'info')
      } catch (error) {
        person.ctx.ui.notify(`Could not save the rule: ${error instanceof Error ? error.message : String(error)}. Allowed once.`, 'warning')
      }
      return allow('person', { fullEnv: true })
    }
    case 'deny':
      return refuse('person', choice.reason
        ? `The user declined this and said: "${choice.reason}". Follow that; don't retry the same action.`
        : o.declined ?? 'The user declined this. Do not retry it; continue another way or ask the user what they want.')
  }
}

async function review(op: Operation, g: GateContext, why: string): Promise<Verdict> {
  const { rt, config } = g
  if (g.mode === 'ask') {
    return askPerson(op, g, { why: 'Ask mode: you review what Runway would otherwise send to Jev', whyTone: 'normal', unattended: 'Blocked by Runway: this needs a review, Runway is in ask mode, and nobody is available to ask. Do not retry; finish what you can and report what still needs the user.' })
  }
  const unattended = (reason: string) => `Blocked by Runway: ${reason}, and nobody is available to ask. Do not retry; finish what you can and report what still needs the user.`
  const key = await resolveReviewerKey(config.reviewer.route, g.ctx.modelRegistry ?? {}, process.env, rt.agentDir)
  if (!key) return askPerson(op, g, { why: 'No reviewer is set up (add an OpenRouter key for Jev), so you decide', whyTone: 'normal', unattended: unattended('no reviewer key is configured') })
  if (tooLargeToReview(op)) return askPerson(op, g, { why: 'Too large for the reviewer to read in full, so you decide', whyTone: 'warning', unattended: unattended('this call is too large for the reviewer to read in full') })
  if (rt.breaker.isCoolingDown()) return askPerson(op, g, { why: 'The reviewer is unavailable right now', whyTone: 'warning', unattended: unattended('the reviewer is unavailable') })

  let verdict: JevVerdict
  g.onProgress?.(`reviewing ${op.tool}…`)
  rt.stats.reviewed += 1
  const started = Date.now()
  try {
    const transcript = g.replay?.transcript ?? renderTranscriptForState(g.ctx.sessionManager.getBranch() as never).entries
    verdict = await askJev({ action: reviewerAction(op, g), transcript }, key, config.reviewer, { fetchImpl: g.fetchImpl, signal: g.signal, reviewer: g.reviewer })
    rt.breaker.recordSuccess()
    g.onReview?.({ verdict })
    const t = rt.tally.for(g.sessionId)
    if (verdict.outcome === 'allow') t.jev.allowed += 1
    else t.jev.refused += 1
    rt.tally.jevLatency(g.sessionId, verdict.latencyMs)
  } catch (error) {
    if (error instanceof ReviewerError && error.kind === 'cancelled') return refuse('unavailable', 'Cancelled.')
    rt.breaker.recordFailure()
    rt.tally.for(g.sessionId).jev.failed += 1
    const detail = error instanceof Error ? error.message : String(error)
    g.onReview?.({ failure: error instanceof ReviewerError ? error.kind : 'error', latencyMs: Date.now() - started })
    return askPerson(op, g, { why: `The reviewer could not decide (${detail})`, whyTone: 'warning', unattended: unattended(`the reviewer could not decide (${detail})`) })
  } finally {
    g.onProgress?.(undefined)
  }
  rt.record({ session: g.sessionId, kind: op.kind, summary: op.summary, decision: verdict.outcome === 'allow' ? 'allowed' : 'denied', by: 'reviewer', why: `${verdict.why}; risk ${verdict.risk}, authorization ${verdict.authorization}${why ? `; ${why}` : ''}`, latencyMs: verdict.latencyMs, tool: op.tool })
  if (verdict.outcome === 'allow') return allow('reviewer')
  const reason = explainVerdict(verdict)
  const blocked = `Blocked by Runway's reviewer: ${reason}. Do not retry the same action. If it is genuinely needed, tell the user what you want to do and why, and ask them to confirm in the chat; after they explicitly confirm, you may try once more.`
  if (config.onDeny === 'ask' && rt.personFor(g.sessionId)) {
    return askPerson(op, g, { why: `Jev said no: ${reason}`, whyTone: 'danger', focusDeny: true, unattended: blocked, declined: `Blocked: Runway's reviewer said ${reason}, and the user did not approve it. Do not retry the same action; continue another way or ask the user in the chat.` })
  }
  const person = rt.personFor(g.sessionId)
  if (person) person.ctx.ui.notify(`Jev blocked: ${op.summary.length > 80 ? `${op.summary.slice(0, 79)}…` : op.summary}\n${reason} · /runway log`, 'warning')
  return refuse('reviewer', blocked)
}

export async function gate(op: Operation, g: GateContext): Promise<Verdict> {
  const { rt } = g
  if (g.mode === 'off') return allow('mode')
  const rctx = { policy: g.policy }
  const user = g.config.permissions
  const done = (v: Verdict, why?: string): Verdict => {
    if (v.allow) rt.stats.allowed += 1
    else rt.stats.denied += 1
    if (op.kind !== 'network') {
      const t = rt.tally.for(g.sessionId)
      t.toolCalls += 1
      if (op.kind === 'shell') t.commands += 1
      if (!v.allow) t.refused += 1
      // Allowed to act outside the sandbox (or inside Pi) by someone's decision, not a routine default.
      if (v.allow && (op.execution === 'unsandboxed' || op.execution === 'in-process') && v.by !== 'default') {
        if (v.by === 'reviewer') t.outside.jev += 1
        else if (v.by === 'person') t.outside.you += 1
        else t.outside.rulesOrGrants += 1
      }
    }
    // Quiet success: routine allows by rules and defaults aren't logged one by one.
    if (!(v.allow && (v.by === 'default' || v.by === 'rule' || v.by === 'grant')) && v.by !== 'reviewer') {
      rt.record({ session: g.sessionId, kind: op.kind, summary: op.summary, decision: v.allow ? 'allowed' : 'denied', by: v.by, why: why ?? v.message, tool: op.tool })
    }
    return v
  }

  const denyRule = strongestMatch(user, op, rctx, ['deny'])
  if (denyRule) return done(refuse('rule', ruleRefusal(denyRule), { rule: denyRule }), `rule: deny ${describeRule(denyRule)}`)

  if (rt.grants.findPersonGrant(g.sessionId, op, 'operation')) return done(allow('grant', { fullEnv: true, sawCall: true }))

  const unsettled = uncertainRestrictive(user, op)
  if (unsettled && unsettled !== strongestMatch(user, op, rctx, ['ask'])) {
    return done(await askPerson(op, g, {
      why: `Your rule ${unsettled.action === 'deny' ? 'blocks' : 'asks before'} ${describeRule(unsettled)}, and this command builds what it runs at run time (${op.shell?.opaqueReasons.join(', ')}), so Runway can't tell whether it applies`,
      whyTone: unsettled.action === 'deny' ? 'danger' : 'warning',
      focusDeny: unsettled.action === 'deny',
      unattended: `Blocked by Runway: a rule (${unsettled.action} ${describeRule(unsettled)}) may apply and this command hides what it runs (${op.shell?.opaqueReasons.join(', ')}). Rewrite it so the commands it runs are written out plainly, or report what still needs the user.`,
    }))
  }

  const userRule = strongestMatch(user, op, rctx, ['ask', 'auto', 'allow'])
  if (userRule?.action === 'ask') {
    return done(await askPerson(op, g, {
      why: `Your rule asks first: ${describeRule(userRule)}${userRule.reason ? ` — ${userRule.reason}` : ''}`,
      whyTone: 'normal',
      unattended: `Blocked by Runway: a rule (ask ${describeRule(userRule)}) requires the user's OK and nobody is available to ask. Do not retry; report what still needs the user.`,
    }))
  }
  if (userRule?.action === 'allow') return done(allow('rule', { rule: userRule }))
  const parts = userRule ? undefined : allowedPartByPart(user, op, rctx)
  if (parts) return done(allow('rule', { rule: parts[0] }))

  const defaults = defaultRules()
  const safeguard = strongestMatch(defaults, op, rctx, ['ask'])
  if (safeguard) {
    return done(await askPerson(op, g, {
      why: safeguard.description ?? 'A built-in safeguard asks first',
      whyTone: 'warning',
      unattended: `Blocked by Runway: ${(safeguard.description ?? 'this').replace(/^Ask before /, 'it needs a person before ')}, and nobody is available to ask. Do not retry; report what still needs the user.`,
    }))
  }

  if (rt.grants.findPersonGrant(g.sessionId, op, 'tool')) return done(allow('grant'))

  if (userRule?.action === 'auto') return done(await review(op, g, `rule: auto ${describeRule(userRule)}`))

  // Built-in defaults are ordered; the first allow that fits wins, the rest is reviewed.
  const fallback = defaults.find(r => r.action === 'allow' && ruleMatches(r, op, rctx))
  if (fallback) return done(allow('default', { rule: fallback }))

  return done(await review(op, g, ''))
}
