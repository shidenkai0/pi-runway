import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BashOperations, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { callKey } from './runtime.ts'
import type { Runtime } from './runtime.ts'
import { isBroadRoot } from './policy.ts'
import type { Policy } from './policy.ts'
import { scrubEnv } from './env.ts'
import { ensureCommonCaches, gitExcludeEnv, nestedControlPaths } from './linux.ts'
import type { Endpoint } from './permissions/operation.ts'

// Running commands. Sandboxed commands are wrapped by sandbox-runtime
// (Seatbelt on macOS, bubblewrap on Linux) with per-command filesystem rules
// for the command's own working directory; the network goes through the
// process-wide proxy. Escalated commands run directly, with secrets still
// scrubbed from the environment unless a person approved them.

// New repositories (git init, git clone, cargo init) copy sample hooks from a
// template; hooks can never be written in the sandbox, so use an empty template.
const EMPTY_GIT_TEMPLATE = join(tmpdir(), 'pi-runway-empty-git-template')

function commandEnv(env: NodeJS.ProcessEnv, keepEnv: readonly string[]): NodeJS.ProcessEnv {
  const out = scrubEnv(env, keepEnv).env
  // cargo new/init create repositories through libgit2, which ignores the
  // template and writes sample hooks; let the agent run `git init` itself.
  if (!out.CARGO_CARGO_NEW_VCS) out.CARGO_CARGO_NEW_VCS = 'none'
  if (!out.GIT_TEMPLATE_DIR) {
    try {
      mkdirSync(EMPTY_GIT_TEMPLATE, { recursive: true })
      out.GIT_TEMPLATE_DIR = EMPTY_GIT_TEMPLATE
    } catch {
      // without it, git init/clone inside the sandbox fails on the hooks folder
    }
  }
  return out
}

const VIOLATION_LINE = /(file-write|file-read|network-outbound|deny network|deny\(1\) (file|network)|not on the allow list|denied by|user denied|permission prompt failed)/

export const SANDBOX_HINT =
  '[runway] The sandbox blocked part of this command. Most work never needs more; first look for a way inside the project ' +
  '(project-local paths, allowed package registries). If the task truly needs this, re-run the command with ' +
  '"escalate": true and a one-sentence "justification"; it will be reviewed.'

function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

interface SpawnOptions {
  wrapped: string
  cwd: string
  env: NodeJS.ProcessEnv
  onData: (data: Buffer) => void
  signal?: AbortSignal
  timeout?: number
  onStderr?: (data: Buffer) => void
}

function run(options: SpawnOptions): Promise<{ exitCode: number | null }> {
  const { wrapped, cwd, env, onData, signal, timeout } = options
  if (!existsSync(cwd)) return Promise.reject(new Error(`Working directory does not exist: ${cwd}`))
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', ['-c', wrapped], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    const timer = timeout && timeout > 0 ? setTimeout(() => { timedOut = true; killTree(child.pid) }, timeout * 1000) : undefined
    const onAbort = () => killTree(child.pid)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (data: Buffer) => {
      onData(data)
      options.onStderr?.(data)
    })
    child.on('error', error => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) reject(new Error('aborted'))
      else if (timedOut) reject(new Error(`timeout:${timeout}`))
      else resolvePromise({ exitCode: code ?? (sig ? 128 : 1) })
    })
  })
}

export interface CommandAccess {
  /** Extra folders this one command may write (approved with the command). */
  write: string[]
  /** Where this command was approved to connect (see ApprovedCall.endpoints). */
  endpoints: Endpoint[]
}

export function sandboxedOperations(
  rt: Runtime,
  toolCallId: string,
  ctx: ExtensionContext,
  policyFor: (cwd: string) => Policy,
  keepEnv: readonly string[],
  access: CommandAccess = { write: [], endpoints: [] },
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const policy = policyFor(cwd)
      const id = callKey(ctx.sessionManager.getSessionId(), toolCallId)
      // Requested write access never reaches protected control paths: denies win in the sandbox.
      const allowWrite = [...policy.allowWrite, ...access.write]
      const base = commandEnv(env ?? process.env, keepEnv)
      const excludes = gitExcludeEnv(cwd, policy.denyWrite, base)
      // Linux can't take `**` denies: list the nested control folders that exist right now
      // (the cached policy may predate one the previous command created).
      ensureCommonCaches()
      const nested = process.platform === 'linux' && !isBroadRoot(policy.workspace) ? nestedControlPaths(policy.workspace) : []
      const denyWrite = [...new Set([...policy.denyWrite, ...nested, ...(excludes ? [excludes.dir] : [])])]
      let wrapped: string
      try {
        wrapped = await rt.sandbox.wrapWithSandbox(
          command,
          'bash',
          { filesystem: { denyRead: policy.denyRead, allowRead: policy.allowRead, allowWrite, denyWrite } },
          signal,
          { commandId: id, commandText: command },
        )
      } catch (error) {
        excludes?.cleanup()
        throw error
      }
      const stderr: Buffer[] = []
      let stderrBytes = 0
      rt.running.set(id, { command, cwd, sessionId: ctx.sessionManager.getSessionId(), endpoints: [...access.endpoints] })
      try {
        const result = await run({
          wrapped,
          cwd,
          env: excludes ? { ...base, ...excludes.env } : base,
          onData,
          signal,
          timeout,
          onStderr: data => {
            if (stderrBytes < 65_536) {
              stderr.push(data)
              stderrBytes += data.length
            }
          },
        })
        if (result.exitCode !== 0) {
          // Seatbelt reports violations through the system log a moment after the fact.
          if (process.platform === 'darwin') await new Promise(r => setTimeout(r, 150))
          const text = Buffer.concat(stderr).toString('utf8')
          const annotated = rt.sandbox.annotateStderrWithSandboxFailures(id, text)
          const extra = annotated.startsWith(text) ? annotated.slice(text.length) : annotated
          // Lines without a target (e.g. a bare "network-outbound") are background noise, not the cause.
          const violations = extra.split('\n').filter(line => VIOLATION_LINE.test(line) && !/network-outbound\s*$/.test(line))
          if (violations.length > 0) {
            onData(Buffer.from(`\n<sandbox_violations>\n${violations.slice(0, 20).join('\n')}\n</sandbox_violations>\n${SANDBOX_HINT}\n`))
          }
        }
        return result
      } finally {
        rt.running.delete(id)
        excludes?.cleanup()
        // The session may have ended while this command ran (pi -p); stop the sandbox now.
        if (rt.sessions.size === 0) void rt.releaseIfIdle()
        try {
          rt.sandbox.cleanupAfterCommand()
        } catch {
          // Linux mount-point cleanup is best effort
        }
      }
    },
  }
}

/** Unsandboxed execution for approved escalations. */
export function directOperations(keepEnv: readonly string[], fullEnv: boolean): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeout, env }) {
      const base = env ?? process.env
      return run({ wrapped: command, cwd, env: fullEnv ? base : scrubEnv(base, keepEnv).env, onData, signal, timeout })
    },
  }
}
