import { fileURLToPath } from 'node:url'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { createBashToolDefinition, getAgentDir } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { directOperations, sandboxedOperations } from './bash.ts'
import { COMPANIONS, installedPackageNames, listedPackages, loadCompanions, verifyCompanions } from './companions.ts'
import type { CompanionId, CompanionStatus } from './companions.ts'
import { loadConfig } from './config.ts'
import type { Mode, RunwayConfig } from './config.ts'
import { gate } from './permissions/gate.ts'
import type { Verdict } from './permissions/gate.ts'
import { networkOperation, normalize, parseHostPort } from './permissions/operation.ts'
import type { Endpoint, Operation, ToolIdentity, ToolMeta } from './permissions/operation.ts'
import { buildPolicy } from './policy.ts'
import type { Policy } from './policy.ts'
import { resolveReviewerKey } from './review/jev.ts'
import { runtime } from './runtime.ts'
import type { Runtime } from './runtime.ts'
import { refreshStatus, registerUi } from './ui/commands.ts'
import { backgroundVerdict, connectionVerdict } from './network.ts'
import { GUARDED_SEARCH_TOOLS, guardedSearchTools } from './search.ts'
import { registerWorktree } from './worktree.ts'

// Runway: autonomous coding in Pi, with mistakes contained.
//
//  * Every tool call — built-in, bash, web, MCP, another extension's tool, a
//    call made from a codemode script or by a subagent — goes through one
//    permission gate (permissions/gate.ts): your rules and session approvals
//    first, everything undecided to the reviewer (Jev), you as the fallback.
//  * Independently of that decision, commands run in an OS sandbox: the
//    project is writable, credential stores are not readable, secrets are
//    removed from the environment, and only known hosts are reachable.
//  * Subagents, plan mode and web tools come bundled (companions.ts).

interface SessionState {
  config: RunwayConfig
  problems: string[]
  generation: number
}

const PI_CORE_TOOLS = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'powershell'])
const SELF = (() => {
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return ''
  }
})()

export function effectiveMode(rt: Runtime, config: RunwayConfig): Mode {
  return rt.modeOverride ?? config.mode ?? 'auto'
}

function safeTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted()
  } catch {
    return false
  }
}

/**
 * Freeze approved arguments so a later handler can't change what runs (Pi
 * keeps this same object). Already-frozen objects are still walked: a frozen
 * root can hold a mutable nested object.
 */
export function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  Object.freeze(value)
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v, seen)
}

/** Where an allowed call may connect: requested hosts always, hosts named in the command only if whoever allowed it saw it. */
function approvedEndpoints(op: Operation, verdict: Verdict): Endpoint[] {
  if (verdict.sawCall) return op.endpoints
  return (op.access?.hosts ?? []).map(parseHostPort)
}

export default async function runway(pi: ExtensionAPI): Promise<void> {
  const rt = runtime()
  rt.agentDir = getAgentDir()
  const sessionState = new Map<string, SessionState>()
  const companionOwners = new Map<string, CompanionId>()
  let companions: CompanionStatus[] = []

  const configFor = (ctx: ExtensionContext): { config: RunwayConfig; problems: string[] } => {
    const id = ctx.sessionManager.getSessionId()
    const cached = sessionState.get(id)
    if (cached && cached.generation === rt.configGeneration) return cached
    const loaded = loadConfig(ctx.cwd, { projectTrusted: safeTrusted(ctx) })
    const state = { config: loaded.config, problems: loaded.problems, generation: rt.configGeneration }
    sessionState.set(id, state)
    return state
  }

  const policyCache = new Map<string, { at: number; policy: Policy }>()
  const policyFor = (cwd: string, config: RunwayConfig): Policy => {
    const cached = policyCache.get(cwd)
    if (cached && Date.now() - cached.at < 5_000) return cached.policy
    const policy = buildPolicy(cwd, config, rt.agentDir)
    policyCache.set(cwd, { at: Date.now(), policy })
    return policy
  }

  // ---------- companions (before our gate, so e.g. plan mode can refuse edits first) ----------

  {
    const startup = loadConfig(process.cwd(), { projectTrusted: false })
    companions = await loadCompanions(pi, startup.config, installedPackageNames(rt.agentDir, process.cwd()), companionOwners)
    rt.companions = companions
  }

  // ---------- tool identity: from Pi's registry, never from a name alone ----------

  const identityOf = (toolName: string): { identity: ToolIdentity; info?: ReturnType<ExtensionAPI['getAllTools']>[number] } => {
    let info: ReturnType<ExtensionAPI['getAllTools']>[number] | undefined
    try {
      info = pi.getAllTools().find(t => t.name === toolName)
    } catch {
      info = undefined
    }
    if (!info) return { identity: { kind: 'unknown' } }
    const path = info.sourceInfo?.path ?? ''
    if (path.startsWith('builtin:')) {
      const name = path.slice('builtin:'.length)
      return { identity: PI_CORE_TOOLS.has(name) ? { kind: 'pi-builtin', name } : { kind: 'pi-extension', name }, info }
    }
    const ours = SELF !== '' && path === SELF
    if (ours && toolName === 'bash' && isRunwayBash(info.parameters)) return { identity: { kind: 'runway' }, info }
    if (ours && GUARDED_SEARCH_TOOLS.has(toolName)) return { identity: { kind: 'runway' }, info }
    const companion = companionOwners.get(toolName)
    if (ours && companion) return { identity: { kind: 'companion', companion }, info }
    return { identity: { kind: 'extension', path }, info }
  }

  const metaFor = (toolName: string): ToolMeta => {
    const { identity, info } = identityOf(toolName)
    return {
      identity,
      source: identity.kind === 'pi-builtin' || identity.kind === 'runway' ? 'builtin' : identity.kind === 'pi-extension' && identity.name === 'mcp' ? 'mcp' : identity.kind === 'unknown' ? 'unknown' : 'extension',
      sourcePath: info?.sourceInfo?.path,
      namespace: (info as { namespace?: { name?: string } } | undefined)?.namespace?.name,
      annotations: (info as { annotations?: ToolMeta['annotations'] } | undefined)?.annotations,
      description: info?.description,
    }
  }

  const decide = (op: Operation, ctx: ExtensionContext, signal?: AbortSignal): Promise<Verdict> => {
    const { config } = configFor(ctx)
    const sessionId = ctx.sessionManager.getSessionId()
    const person = rt.personFor(sessionId)
    return gate(op, {
      rt, config, policy: policyFor(op.cwd, config), mode: effectiveMode(rt, config), ctx, sessionId, signal,
      onProgress: text => {
        if (person) refreshStatus(person.ctx, rt, effectiveMode(rt, config), text)
      },
    })
  }

  // ---------- the one gate ----------

  pi.on('tool_call', async (event, ctx) => {
    const { config } = configFor(ctx)
    if (effectiveMode(rt, config) === 'off') return undefined
    const input = (event.input ?? {}) as Record<string, unknown>
    const op = normalize({
      tool: event.toolName, input, cwd: ctx.cwd, toolCallId: event.toolCallId,
      parentToolCallId: (event as { parentToolCallId?: string }).parentToolCallId, meta: metaFor(event.toolName),
    })
    const verdict = await decide(op, ctx, ctx.signal)
    if (!verdict.allow) return { block: true, reason: verdict.message ?? 'Blocked by Runway.' }
    // Runway's bash reads the decision back when it runs (and decides again if the arguments changed).
    if (op.kind === 'shell') rt.recordApproval(ctx.sessionManager.getSessionId(), event.toolCallId, { inputKey: op.key, fullEnv: verdict.fullEnv, endpoints: approvedEndpoints(op, verdict) })
    deepFreeze(event.input)
    return undefined
  })

  // A call blocked or failed after our gate never reaches execute: drop its approval.
  pi.on('tool_execution_end', (event, ctx) => {
    rt.dropApproval(ctx.sessionManager.getSessionId(), event.toolCallId)
  })

  // ---------- bash: sandboxed, with scoped extra access or (reviewed) outside the sandbox ----------

  const template = createBashToolDefinition(process.cwd())
  const parameters = Type.Object({
    command: Type.String({ description: 'Bash command to execute' }),
    timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
    access: Type.Optional(Type.Object({
      write: Type.Optional(Type.Array(Type.String(), { description: 'Extra folders this command must write to, outside the project (e.g. a sibling repository).' })),
      hosts: Type.Optional(Type.Array(Type.String(), { description: 'Extra network hosts this command must reach (e.g. "api.example.com").' })),
    }, { description: 'Ask for specific extra sandbox access for this one command. The request is reviewed.' })),
    escalate: Type.Optional(Type.Boolean({ description: 'Run outside the sandbox with the user\'s full access. Only for things the sandbox cannot do even with `access` (stored credentials, Keychain, Docker). The request is reviewed.' })),
    justification: Type.Optional(Type.String({ description: 'With access or escalate: one sentence on why this command needs it.' })),
  })

  pi.registerTool({
    ...template,
    label: 'bash',
    description: `${template.description} Commands run in a sandbox: the project and temp/cache folders are writable, credential stores are not readable, secret environment variables are removed, and only known package/code hosts are reachable (others are reviewed).`,
    promptGuidelines: [
      ...(template.promptGuidelines ?? []),
      'bash runs inside a sandbox and every command is reviewed. If a command fails with <sandbox_violations>, first prefer a way inside the project. If it truly needs more, re-run with "access" (specific extra write folders or hosts) and a one-sentence "justification"; only use "escalate": true when it must run with the user\'s full access (stored credentials, Keychain, Docker).',
    ],
    parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { command, timeout } = params
      const { config } = configFor(ctx)
      const mode = effectiveMode(rt, config)
      const plain = { command, timeout }
      if (mode === 'off') return createBashToolDefinition(ctx.cwd).execute(toolCallId, plain, signal, onUpdate, ctx)
      const sessionId = ctx.sessionManager.getSessionId()
      const op = normalize({ tool: 'bash', input: params as Record<string, unknown>, cwd: ctx.cwd, toolCallId, meta: metaFor('bash') })
      let approved = rt.takeApproval(sessionId, toolCallId, op.key)
      if (!approved) {
        // The gate's decision was for different arguments (or none was recorded): decide again.
        const verdict = await decide(op, ctx, signal ?? undefined)
        if (!verdict.allow) throw new Error(verdict.message ?? 'Blocked by Runway.')
        approved = { inputKey: op.key, fullEnv: verdict.fullEnv, endpoints: approvedEndpoints(op, verdict), sessionId }
      }
      const { fullEnv, endpoints } = approved
      if (op.execution === 'unsandboxed' || !rt.sandboxReady()) {
        if (op.execution !== 'unsandboxed') throw new Error(`Runway: the sandbox is not running (${rt.sandboxError ?? 'not started'}), so commands can't run contained. Re-run with "escalate": true and a justification if this must run anyway; it will be reviewed as running outside the sandbox.`)
        return createBashToolDefinition(ctx.cwd, { operations: directOperations(config.keepEnv, fullEnv) }).execute(toolCallId, plain, signal, onUpdate, ctx)
      }
      const ops = sandboxedOperations(rt, toolCallId, ctx, cwd => policyFor(cwd, config), config.keepEnv, { write: op.access?.write ?? [], endpoints })
      return createBashToolDefinition(ctx.cwd, { operations: ops }).execute(toolCallId, plain, signal, onUpdate, ctx)
    },
  })

  // Pi's optional grep/find/ls, guarded so secrets files are never shown (still off unless you enable them).
  for (const tool of guardedSearchTools((cwd, ctx) => policyFor(cwd, configFor(ctx).config))) pi.registerTool(tool)

  // `!` commands are typed by you; they run as you typed them unless you ask for the sandbox.
  pi.on('user_bash', (_event, ctx) => {
    const { config } = configFor(ctx)
    if (!config.sandboxUserCommands || effectiveMode(rt, config) === 'off' || !rt.sandboxReady()) return undefined
    return { operations: sandboxedOperations(rt, `user-${Date.now()}`, ctx, cwd => policyFor(cwd, config), config.keepEnv) }
  })

  // ---------- network: hosts the sandbox doesn't already allow ----------

  // Every connection out of the sandbox comes here (src/network.ts has the rules).
  // The proxy only knows host and port, not which running command opened the
  // connection, so it's allowed only if every command running at that moment
  // may reach that host:port on its own.
  const pendingNetwork = new Map<string, Promise<boolean>>()
  const decisions = new WeakMap<object, Map<string, boolean>>()
  const mayConnect = async (id: string, host: string, port: number | undefined): Promise<boolean> => {
    const r = rt.running.get(id)
    if (!r) return true // finished meanwhile: it isn't the requester
    const session = rt.sessions.get(r.sessionId)
    if (!session) return false
    const { config } = configFor(session.ctx)
    if (effectiveMode(rt, config) === 'off') return true
    const op = networkOperation(host, port, r.cwd, [r.command])
    const verdict0 = connectionVerdict(op, config, policyFor(r.cwd, config), r.endpoints)
    if (verdict0 !== 'gate') return verdict0 === 'allow'
    // Decided once per running command and host:port; "for this session" is a grant the gate keeps.
    const decided = decisions.get(r) ?? new Map<string, boolean>()
    decisions.set(r, decided)
    const key = `${host}:${port ?? ''}`
    const earlier = decided.get(key)
    if (earlier !== undefined) return earlier
    const verdict = await decide(op, session.ctx)
    decided.set(key, verdict.allow)
    return verdict.allow
  }
  rt.networkAsk = async (host, port) => {
    const ids = [...rt.running.keys()]
    if (ids.length === 0) {
      // Something an earlier command left running. Nobody can be asked on its
      // behalf: only what every open session would let through without asking.
      return rt.sessions.size > 0 && [...rt.sessions.values()].every(s => {
        const { config } = configFor(s.ctx)
        if (effectiveMode(rt, config) === 'off') return true
        return backgroundVerdict(networkOperation(host, port, s.ctx.cwd, []), config, policyFor(s.ctx.cwd, config))
      })
    }
    for (const id of ids) {
      const k = `${id}|${host}:${port ?? ''}`
      let pending = pendingNetwork.get(k)
      if (!pending) {
        pending = mayConnect(id, host, port).finally(() => pendingNetwork.delete(k))
        pendingNetwork.set(k, pending)
      }
      if (!(await pending)) return false
    }
    return true
  }

  // ---------- sessions and subagents ----------

  const pendingNames = new Map<string, string[]>()
  pi.events.on('subagents:child:spawning', (data: unknown) => {
    const e = data as { agentName?: string; parentSessionId?: string }
    if (!e.parentSessionId || !e.agentName) return
    const queue = pendingNames.get(e.parentSessionId) ?? []
    queue.push(e.agentName)
    pendingNames.set(e.parentSessionId, queue)
  })
  pi.events.on('subagents:child:session-created', (data: unknown) => {
    const e = data as { sessionId?: string; parentSessionId?: string }
    if (!e.sessionId || !e.parentSessionId) return
    rt.grants.setParent(e.sessionId, e.parentSessionId)
    const name = pendingNames.get(e.parentSessionId)?.shift()
    if (name) rt.agentNames.set(e.sessionId, name)
  })
  pi.events.on('subagents:child:disposed', (data: unknown) => {
    const e = data as { sessionId?: string }
    if (!e.sessionId) return
    // A child session may be disposed without a shutdown event.
    rt.sessions.delete(e.sessionId)
    rt.grants.reset(e.sessionId)
    rt.agentNames.delete(e.sessionId)
    sessionState.delete(e.sessionId)
    void rt.releaseIfIdle()
  })

  pi.on('session_start', async (event, ctx) => {
    rt.agentDir = getAgentDir()
    const id = ctx.sessionManager.getSessionId()
    rt.sessions.set(id, { id, ctx, hasUI: ctx.hasUI })
    rt.sessionsStarted = true
    sessionState.delete(id)
    const { config, problems } = configFor(ctx)
    rt.reviewerKeyPresent = Boolean(await resolveReviewerKey(config.reviewer.route, ctx.modelRegistry ?? {}, process.env, rt.agentDir))
    try {
      verifyCompanions(companions, listedPackages(rt.agentDir, ctx.cwd, safeTrusted(ctx)), [...pi.getAllTools(), ...pi.getCommands()])
    } catch {
      // registry not readable: doctor shows the load-time state
    }
    const mode = effectiveMode(rt, config)
    if (mode !== 'off') await rt.ensureSandbox(config, policyFor(ctx.cwd, config))
    // Without a screen (pi -p, CI) settings problems go to stderr, so a broken rule is never silent.
    if (!ctx.hasUI && !rt.grants.parentOf(id)) for (const problem of problems) process.stderr.write(`Runway settings: ${problem}\n`)
    if (ctx.hasUI && !rt.grants.parentOf(id)) {
      for (const problem of problems) ctx.ui.notify(`Runway settings: ${problem}`, 'warning')
      if (mode !== 'off' && rt.sandboxState !== 'ready') ctx.ui.notify(`Runway: the sandbox did not start (${rt.sandboxError ?? 'unknown error'}). Commands won't run until it does, unless one is approved to run outside it.`, 'warning')
      if ((event as { reason?: string }).reason === 'startup' && !rt.reviewerKeyPresent) ctx.ui.notify('Runway: no reviewer key, so you will be asked instead of Jev. Set OPENROUTER_API_KEY or /login to OpenRouter.', 'info')
      for (const c of companions.filter(c => c.state === 'failed')) ctx.ui.notify(`Runway: bundled ${c.label.toLowerCase()} did not load (${c.detail})`, 'warning')
      for (const c of companions.filter(c => c.state === 'inactive')) ctx.ui.notify(`Runway: ${c.label.toLowerCase()} is off — your ${c.pkg} is listed in Pi settings but not loaded. /runway doctor`, 'warning')
      refreshStatus(ctx, rt, mode)
    }
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId()
    rt.sessions.delete(id)
    sessionState.delete(id)
    await rt.releaseIfIdle()
  })

  registerUi(pi, rt, { effectiveMode: config => effectiveMode(rt, config), configFor, policyFor, companions: () => companions, identityOf: name => identityOf(name).identity })
  registerWorktree(pi)
}

/** Runway's bash is the one that accepts `escalate` and `access`. */
export function isRunwayBash(parameters: unknown): boolean {
  const props = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return Boolean(props && 'escalate' in props && 'access' in props)
}

export { COMPANIONS }
