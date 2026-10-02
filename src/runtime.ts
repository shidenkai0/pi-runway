import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { Mode, RunwayConfig } from './config.ts'
import type { Policy } from './policy.ts'
import { GrantStore } from './permissions/grants.ts'
import { AvailabilityBreaker } from './review/availability.ts'
import { redactSecrets } from './review/redact.ts'
import type { Endpoint } from './permissions/operation.ts'

// Process-wide state. Pi may load this extension more than once in one
// process (in-process subagents get their own copy of every extension), so
// everything that must be shared — the sandbox and its network proxy, session
// grants, the person to ask — lives on one object hanging off globalThis.

type SandboxApi = typeof SandboxManager

export interface SessionInfo {
  id: string
  ctx: ExtensionContext
  hasUI: boolean
}

export interface RunningCommand {
  command: string
  cwd: string
  sessionId: string
  /** Where this command may connect beyond the policy's hosts; grows as its own network requests are approved. */
  endpoints: Endpoint[]
}

export interface LogEntry {
  at: string
  session: string
  kind: string
  summary: string
  decision: 'allowed' | 'denied'
  by: 'reviewer' | 'person' | 'rule' | 'default' | 'grant' | 'mode' | 'unavailable'
  why?: string
  latencyMs?: number
  tool?: string
}

/** Tool call ids are only unique within a session: approvals and running commands are keyed by both. */
export function callKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`
}

export type NetworkAsk = (host: string, port: number | undefined) => Promise<boolean>

/** What the gate decided for a tool call, read back when the tool runs. */
export interface ApprovedCall {
  inputKey: string
  fullEnv: boolean
  /** Where this call was approved to connect (requested as access, or named in a command someone reviewed). */
  endpoints: Endpoint[]
  sessionId: string
}

export class Runtime {
  readonly sandbox: SandboxApi
  sandboxState: 'idle' | 'starting' | 'ready' | 'failed' | 'unsupported' = 'idle'
  sandboxError: string | undefined
  networkMode: RunwayConfig['network'] | undefined
  private startPromise: Promise<void> | undefined

  /** Session-level override set with /runway or the shortcut; undefined = use config/default. */
  modeOverride: Mode | undefined
  config: RunwayConfig | undefined
  configProblems: string[] = []
  agentDir = ''
  reviewerKeyPresent = false

  readonly sessions = new Map<string, SessionInfo>()
  readonly grants = new GrantStore()
  /** Subagent session id → its agent name (from pi-subagents' lifecycle events). */
  readonly agentNames = new Map<string, string>()
  /** callKey(session, toolCallId) → what the gate approved (checked again when the tool runs). */
  readonly approved = new Map<string, ApprovedCall>()

  /** The gate allowed this call: remember how, for when the tool runs. */
  recordApproval(sessionId: string, toolCallId: string, approval: Omit<ApprovedCall, 'sessionId'>): void {
    this.approved.set(callKey(sessionId, toolCallId), { ...approval, sessionId })
  }

  /**
   * The decision recorded for this session's call, used up. Only if it was
   * for exactly this operation; anything else means decide again.
   */
  takeApproval(sessionId: string, toolCallId: string, opKey: string): ApprovedCall | undefined {
    const key = callKey(sessionId, toolCallId)
    const approval = this.approved.get(key)
    this.approved.delete(key)
    return approval && approval.sessionId === sessionId && approval.inputKey === opKey ? approval : undefined
  }

  dropApproval(sessionId: string, toolCallId: string): void {
    this.approved.delete(callKey(sessionId, toolCallId))
  }
  readonly stats = { allowed: 0, reviewed: 0, asked: 0, denied: 0 }
  /** Bundled companions and how they loaded (for /runway doctor). */
  companions: import('./companions.ts').CompanionStatus[] = []
  /** Bumped whenever settings change, so cached per-session config reloads. */
  configGeneration = 0
  /** Set once a Pi session has started; the sandbox is only released after sessions existed and all ended. */
  sessionsStarted = false
  readonly running = new Map<string, RunningCommand>()
  readonly breaker = new AvailabilityBreaker()
  readonly recent: LogEntry[] = []
  /** Set by ui.ts: tell a person what just left the sandbox. */
  onRecord: ((entry: LogEntry) => void) | undefined
  /** Set by index.ts: decides a network escalation for a host the policy does not know. */
  networkAsk: NetworkAsk | undefined
  private promptChain: Promise<unknown> = Promise.resolve()

  constructor(sandbox: SandboxApi) {
    this.sandbox = sandbox
  }

  // ---------- sandbox lifecycle ----------

  /**
   * Start the sandbox once per process. The network proxy and its ask
   * callback are process-global in sandbox-runtime, so the first session's
   * network mode wins until the mode changes (then we restart it).
   */
  async ensureSandbox(config: RunwayConfig, policy: Policy): Promise<void> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      this.sandboxState = 'unsupported'
      this.sandboxError = `Sandboxing is not available on ${process.platform}; every command will be reviewed instead.`
      return
    }
    // One network mode per Pi process: the first session's. A later session
    // (a subagent, another project via /worktree) never loosens or restarts it.
    if (this.sandboxState === 'ready') return
    if (this.startPromise) {
      await this.startPromise
      if (this.sandboxReady()) return
    }
    this.startPromise = this.start(config, policy)
    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  private async start(config: RunwayConfig, policy: Policy): Promise<void> {
    this.sandboxState = 'starting'
    try {
      const deps = this.sandbox.checkDependencies()
      if (deps.errors.length > 0) throw new Error(deps.errors.join('; '))
      const network: Record<string, unknown> = {
        deniedDomains: policy.deniedHosts,
        allowLocalBinding: true,
        strictAllowlist: false,
      }
      // Every connection comes to networkAsk, even to well-known hosts and in
      // "open" mode, so your host rules apply to all of them; networkAsk
      // allows known hosts (and, in open mode, any host) quickly.
      network.allowedDomains = []
      const ask = async ({ host, port }: { host: string; port: number | undefined }): Promise<boolean> => {
        if (!this.networkAsk) return false
        return this.networkAsk(host, port)
      }
      await this.sandbox.initialize(
        {
          network: network as never,
          // git init/clone must be able to write a new repository's config. The
          // repository you work in keeps its hooks and config protected by
          // explicit rules (policy.controlPaths); hooks stay blocked everywhere.
          filesystem: { denyRead: policy.denyRead, allowRead: policy.allowRead, allowWrite: policy.allowWrite, denyWrite: policy.denyWrite, allowGitConfig: true },
          // Go, gh and other tools verify TLS through trustd on macOS.
          enableWeakerNetworkIsolation: true,
        },
        ask,
        process.platform === 'darwin',
      )
      this.networkMode = config.network
      this.sandboxState = 'ready'
      this.sandboxError = undefined
    } catch (error) {
      this.sandboxState = 'failed'
      this.sandboxError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Stop the sandbox (proxy servers, log monitor) once no session is left, so
   * `pi -p` can exit. A subagent finishing never stops it while its parent
   * session is still open.
   */
  async releaseIfIdle(): Promise<void> {
    if (!this.sessionsStarted || this.sessions.size > 0 || this.running.size > 0) return
    if (this.sandboxState !== 'ready' && this.sandboxState !== 'failed') return
    if (this.startPromise) await this.startPromise.catch(() => undefined)
    try {
      await this.sandbox.reset()
    } catch {
      // best effort
    }
    this.sandboxState = 'idle'
    this.networkMode = undefined
    // Session approvals are keyed by session id and stay for the life of this
    // Pi process, so switching back to an earlier session finds them again.
    this.approved.clear()
  }

  sandboxReady(): boolean {
    return this.sandboxState === 'ready'
  }

  // ---------- people ----------

  /**
   * Who can answer for this session: the session itself if it has a screen,
   * otherwise the nearest ancestor that does (a subagent asks its parent).
   * Unrelated sessions are never asked.
   */
  personFor(sessionId: string): SessionInfo | undefined {
    for (const id of this.grants.lineage(sessionId)) {
      const info = this.sessions.get(id)
      if (info?.hasUI) return info
    }
    return undefined
  }

  /** "The agent" or `Subagent "worker"`. */
  whoIs(sessionId: string): string {
    if (!this.grants.parentOf(sessionId)) return 'The agent'
    const name = this.agentNames.get(sessionId)
    return name ? `Subagent "${name}"` : 'A subagent'
  }

  /** Dialogs are shown one at a time, even when parallel tool calls or subagents escalate together. */
  serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.promptChain.then(task, task)
    this.promptChain = next.catch(() => undefined)
    return next
  }

  // ---------- log ----------

  logPath(): string {
    return join(this.agentDir, 'runway', 'decisions.jsonl')
  }

  record(entry: Omit<LogEntry, 'at'>): void {
    const full: LogEntry = { at: new Date().toISOString(), ...entry, summary: redactSecrets(entry.summary).slice(0, 400) }
    this.recent.push(full)
    if (this.recent.length > 200) this.recent.shift()
    try {
      this.onRecord?.(full)
    } catch {
      // notification is best effort
    }
    if (!this.agentDir) return
    try {
      mkdirSync(dirname(this.logPath()), { recursive: true })
      appendFileSync(this.logPath(), `${JSON.stringify(full)}\n`, { mode: 0o600 })
    } catch {
      // logging is best effort
    }
  }

  readLog(limit: number): LogEntry[] {
    try {
      const lines = readFileSync(this.logPath(), 'utf8').trim().split('\n')
      return lines.slice(-limit).map(line => JSON.parse(line) as LogEntry)
    } catch {
      return this.recent.slice(-limit)
    }
  }
}

const KEY = Symbol.for('pi-runway.runtime')

export function runtime(): Runtime {
  const holder = globalThis as unknown as Record<symbol, Runtime | undefined>
  let rt = holder[KEY]
  if (!rt) {
    rt = new Runtime(SandboxManager)
    holder[KEY] = rt
  }
  return rt
}
