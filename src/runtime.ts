import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { Mode, RunwayConfig } from './config.ts'
import type { Policy } from './policy.ts'
import { AvailabilityBreaker } from './review/availability.ts'
import { redactSecrets } from './review/redact.ts'

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
}

export interface LogEntry {
  at: string
  session: string
  kind: string
  summary: string
  decision: 'allowed' | 'denied'
  by: 'reviewer' | 'person' | 'floor' | 'session-grant' | 'policy' | 'unavailable'
  why?: string
  latencyMs?: number
}

export type NetworkAsk = (host: string, port: number | undefined) => Promise<boolean>

export class Runtime {
  readonly sandbox: SandboxApi
  sandboxState: 'idle' | 'starting' | 'ready' | 'failed' | 'unsupported' = 'idle'
  sandboxError: string | undefined
  networkMode: RunwayConfig['network'] | undefined
  private startPromise: Promise<void> | undefined

  /** Session-level override set with /runway or the shortcut; undefined = use config/default. */
  modeOverride: Mode | undefined
  /** Last effective mode computed at session start; used by the status line. */
  lastMode: Mode = 'ask'
  config: RunwayConfig | undefined
  configProblems: string[] = []
  agentDir = ''
  reviewerKeyPresent = false

  readonly sessions = new Map<string, SessionInfo>()
  /** Set once a Pi session has started; the sandbox is only released after sessions existed and all ended. */
  sessionsStarted = false
  readonly running = new Map<string, RunningCommand>()
  readonly grantedHosts = new Set<string>()
  readonly grantedWriteRoots = new Set<string>()
  readonly grantedReadPaths = new Set<string>()
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
        strictAllowlist: config.network === 'closed',
      }
      // "open" means no domain filter at all: no allowedDomains key.
      if (config.network !== 'open') network.allowedDomains = policy.allowHosts
      const ask = async ({ host, port }: { host: string; port: number | undefined }): Promise<boolean> => {
        if (this.grantedHosts.has(host)) return true
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
    // "For this session" approvals end with the session.
    this.grantedHosts.clear()
    this.grantedWriteRoots.clear()
    this.grantedReadPaths.clear()
  }

  sandboxReady(): boolean {
    return this.sandboxState === 'ready'
  }

  // ---------- people ----------

  /** The session that can show a dialog: this one if it has a UI, otherwise the most recent one that does. */
  personFor(sessionId: string): SessionInfo | undefined {
    const own = this.sessions.get(sessionId)
    if (own?.hasUI) return own
    let found: SessionInfo | undefined
    for (const info of this.sessions.values()) if (info.hasUI) found = info
    return found
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
