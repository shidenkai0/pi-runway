import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { createBashToolDefinition, getAgentDir } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { dirname } from 'node:path'
import { directOperations, sandboxedOperations } from './bash.ts'
import { loadConfig } from './config.ts'
import type { Mode, RunwayConfig } from './config.ts'
import { decide } from './escalate.ts'
import type { Decision, Escalation } from './escalate.ts'
import { checkFloor, OUTWARD_RULE_IDS } from './floor.ts'
import { buildPolicy, checkRead, checkSearchRoot, checkWrite, isBroadRoot, isWithin, resolveToolPath } from './policy.ts'
import type { Policy } from './policy.ts'
import { resolveReviewerKey } from './review/jev.ts'
import { runtime } from './runtime.ts'
import type { Runtime } from './runtime.ts'
import { registerUi, refreshStatus } from './ui.ts'
import { registerWorktree } from './worktree.ts'

// Runway: let Pi work on its own, safely.
//
//  * Commands run in a sandbox: the project (and scratch/cache folders) are
//    writable, credential stores are unreadable, secrets are scrubbed from the
//    environment, and only known package/code hosts are reachable.
//  * Anything that needs to leave the sandbox is an escalation: a fixed
//    always-ask floor goes to a person; everything else is reviewed by Jev
//    in about half a second (auto mode) or by a person (ask mode).

interface SessionState {
  config: RunwayConfig
}

const sessionState = new Map<string, SessionState>()

export function effectiveMode(rt: Runtime, config: RunwayConfig): Mode {
  return rt.modeOverride ?? config.mode ?? (rt.reviewerKeyPresent ? 'auto' : 'ask')
}

function sessionIdOf(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId()
}

function configFor(ctx: ExtensionContext): RunwayConfig {
  const existing = sessionState.get(sessionIdOf(ctx))
  if (existing) return existing.config
  const loaded = loadConfig(ctx.cwd, { projectTrusted: safeTrusted(ctx) })
  sessionState.set(sessionIdOf(ctx), { config: loaded.config })
  return loaded.config
}

function safeTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted()
  } catch {
    return false
  }
}

export default function runway(pi: ExtensionAPI): void {
  const rt = runtime()
  const policyCache = new Map<string, { at: number; policy: Policy }>()
  const policyFor = (cwd: string, config: RunwayConfig): Policy => {
    const cached = policyCache.get(cwd)
    if (cached && Date.now() - cached.at < 5_000) return cached.policy
    const policy = buildPolicy(cwd, config, rt.agentDir || getAgentDir())
    policyCache.set(cwd, { at: Date.now(), policy })
    return policy
  }

  const decideFor = (ctx: ExtensionContext, e: Escalation, signal?: AbortSignal): Promise<Decision> => {
    const config = configFor(ctx)
    return decide({ rt, config, mode: effectiveMode(rt, config), ctx, sessionId: sessionIdOf(ctx), signal }, e)
  }

  // ---------- sessions ----------

  pi.on('session_start', async (_event, ctx) => {
    rt.agentDir = getAgentDir()
    const loaded = loadConfig(ctx.cwd, { projectTrusted: safeTrusted(ctx) })
    sessionState.set(sessionIdOf(ctx), { config: loaded.config })
    rt.config = loaded.config
    rt.configProblems = loaded.problems
    rt.sessions.set(sessionIdOf(ctx), { id: sessionIdOf(ctx), ctx, hasUI: ctx.hasUI })
    rt.sessionsStarted = true
    rt.reviewerKeyPresent = Boolean(await resolveReviewerKey(loaded.config.reviewer.route, ctx.modelRegistry ?? {}, process.env, rt.agentDir))
    const mode = effectiveMode(rt, loaded.config)
    rt.lastMode = mode
    if (mode !== 'off') await rt.ensureSandbox(loaded.config, policyFor(ctx.cwd, loaded.config))
    if (ctx.hasUI) {
      for (const problem of loaded.problems) ctx.ui.notify(`Runway settings: ${problem}`, 'warning')
      if (mode !== 'off' && rt.sandboxState !== 'ready') {
        ctx.ui.notify(`Runway: ${rt.sandboxError ?? 'the sandbox did not start'}. Every command will be reviewed instead.`, 'warning')
      }
      refreshStatus(ctx, rt, mode)
    }
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    rt.sessions.delete(sessionIdOf(ctx))
    sessionState.delete(sessionIdOf(ctx))
    await rt.releaseIfIdle()
  })

  // ---------- network: hosts the policy does not know ----------

  rt.networkAsk = async (host, port) => {
    // Attribute the connection to a running command so the review sees its session and task.
    const running = [...rt.running.values()]
    const owner = running.map(r => rt.sessions.get(r.sessionId)).find(Boolean) ?? [...rt.sessions.values()].at(-1)
    if (!owner) return false
    const config = configFor(owner.ctx)
    if (effectiveMode(rt, config) === 'off') return true
    const decision = await decide(
      { rt, config, mode: effectiveMode(rt, config), ctx: owner.ctx, sessionId: owner.id },
      {
        kind: 'network',
        title: `Connect to ${host}${port ? `:${port}` : ''}`,
        reason: `${host} is not on the list of known package and code hosts`,
        host,
        port,
        command: running.length ? running.map(r => r.command).join('\n---\n').slice(0, 4_000) : undefined,
        cwd: running[0]?.cwd ?? owner.ctx.cwd,
        sessionGrant: { label: host, apply: () => rt.grantedHosts.add(host) },
      },
    )
    return decision.allow
  }

  // ---------- bash ----------

  const template = createBashToolDefinition(process.cwd())
  const parameters = Type.Object({
    command: Type.String({ description: 'Bash command to execute' }),
    timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
    escalate: Type.Optional(
      Type.Boolean({
        description:
          'Run outside the sandbox. Only use after the sandbox blocked something this task truly needs (a network host, a file outside the project, stored credentials). The request is reviewed.',
      }),
    ),
    justification: Type.Optional(Type.String({ description: 'Required with escalate: one sentence on why this must run outside the sandbox.' })),
  })

  pi.registerTool({
    ...template,
    label: 'bash',
    description: `${template.description} Commands run in a sandbox: the project and temp/cache folders are writable, credential stores are not readable, secret environment variables are removed, and only known package/code hosts are reachable (others are reviewed).`,
    promptGuidelines: [
      ...(template.promptGuidelines ?? []),
      'bash runs inside a sandbox. Work inside the project; if a command fails with <sandbox_violations>, prefer an in-project alternative. Only if the task truly needs it, re-run with "escalate": true and a one-sentence "justification" — escalations are reviewed and may be declined.',
    ],
    parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { command, timeout } = params
      const config = configFor(ctx)
      const mode = effectiveMode(rt, config)
      const plain = { command, timeout }
      if (mode === 'off') {
        return createBashToolDefinition(ctx.cwd).execute(toolCallId, plain, signal, onUpdate, ctx)
      }
      if (!params.escalate && rt.sandboxReady()) {
        // Publishing, deploying, rewriting a shared remote or opening a remote shell
        // takes effect on another machine; ask a person even inside the sandbox.
        const outward = checkFloor(command, config.trustedCommands)
        if (outward && OUTWARD_RULE_IDS.has(outward.id)) {
          const decision = await decideFor(ctx, {
            kind: 'outward',
            title: `Run in the sandbox: ${command}`,
            reason: `it ${outward.reason}; that happens outside this machine, so the sandbox cannot undo it`,
            command,
            tool: 'bash',
            cwd: ctx.cwd,
            floor: outward,
          }, signal)
          if (!decision.allow) throw new Error(decision.message)
        }
        const ops = sandboxedOperations(rt, toolCallId, ctx, cwd => policyFor(cwd, config), config.keepEnv)
        return createBashToolDefinition(ctx.cwd, { operations: ops }).execute(toolCallId, plain, signal, onUpdate, ctx)
      }
      const escalated = Boolean(params.escalate)
      const decision = await decideFor(ctx, {
        kind: escalated ? 'command' : 'sandbox-unavailable',
        title: `Run without the sandbox: ${command}`,
        reason: escalated ? 'the agent asked to run this command outside the sandbox' : `the sandbox is unavailable (${rt.sandboxError ?? 'not started'})`,
        command,
        justification: params.justification,
        tool: 'bash',
        cwd: ctx.cwd,
        floor: checkFloor(command, config.trustedCommands),
      }, signal)
      if (!decision.allow) throw new Error(decision.message)
      const ops = directOperations(config.keepEnv, decision.fullEnv)
      return createBashToolDefinition(ctx.cwd, { operations: ops }).execute(toolCallId, plain, signal, onUpdate, ctx)
    },
  })

  // Commands the user types with `!` are the user's own; sandbox them only on request.
  pi.on('user_bash', (_event, ctx) => {
    const config = configFor(ctx)
    if (!config.sandboxUserCommands || effectiveMode(rt, config) === 'off' || !rt.sandboxReady()) return undefined
    return { operations: sandboxedOperations(rt, `user-${Date.now()}`, ctx, cwd => policyFor(cwd, config), config.keepEnv) }
  })

  // ---------- Pi's own file tools ----------

  pi.on('tool_call', async (event, ctx) => {
    const tool = event.toolName
    if (!['read', 'write', 'edit', 'grep', 'find', 'ls'].includes(tool)) return undefined
    const config = configFor(ctx)
    if (effectiveMode(rt, config) === 'off') return undefined
    const input = (event.input ?? {}) as { path?: unknown }
    const raw = typeof input.path === 'string' && input.path ? input.path : '.'
    const path = resolveToolPath(raw, ctx.cwd)
    const policy = policyFor(ctx.cwd, config)

    let escalation: Escalation | undefined
    if (tool === 'read') {
      if ([...rt.grantedReadPaths].some(p => isWithin(path, p))) return undefined
      const verdict = checkRead(path, policy)
      if (!verdict.ok) {
        const inStore = policy.denyRead.some(d => isWithin(path, d))
        escalation = {
          kind: 'read', title: `Read ${path}`, reason: verdict.reason, path, tool, cwd: ctx.cwd,
          floor: inStore ? { id: 'credentials', reason: 'reads a credential store' } : undefined,
          sessionGrant: { label: 'reading this file', apply: () => rt.grantedReadPaths.add(path) },
        }
      }
    } else if (tool === 'write' || tool === 'edit') {
      if ([...rt.grantedWriteRoots].some(p => isWithin(path, p))) {
        const control = checkWrite(path, policy)
        if (control.ok || !control.control) return undefined
      }
      const verdict = checkWrite(path, policy)
      if (!verdict.ok) {
        // A session approval covers the file's folder, unless that folder is your home or a system root.
        const folder = dirname(path)
        const scope = isBroadRoot(folder) ? path : folder
        escalation = {
          kind: 'write', title: `${tool === 'write' ? 'Write' : 'Edit'} ${path}`, reason: verdict.reason, path, tool, cwd: ctx.cwd,
          floor: verdict.control ? { id: 'control-files', reason: 'changes a file that can run code outside the sandbox later' } : undefined,
          sessionGrant: verdict.control ? undefined : { label: scope === path ? 'writing this file' : `Pi's writes in ${folder}`, apply: () => rt.grantedWriteRoots.add(scope) },
        }
      }
    } else {
      if ([...rt.grantedReadPaths].some(p => isWithin(path, p))) return undefined
      const verdict = checkSearchRoot(path, policy, tool === 'grep')
      if (!verdict.ok) {
        escalation = {
          kind: 'search', title: `${tool} in ${path}`, reason: verdict.reason, path, tool, cwd: ctx.cwd,
          floor: { id: 'credentials', reason: 'searches inside credential stores' },
          sessionGrant: { label: `searching ${path}`, apply: () => rt.grantedReadPaths.add(path) },
        }
      }
    }
    if (!escalation) return undefined
    const decision = await decideFor(ctx, escalation)
    return decision.allow ? undefined : { block: true, reason: decision.message }
  })

  registerUi(pi, rt, { effectiveMode: config => effectiveMode(rt, config), configFor, policyFor })
  registerWorktree(pi)
}
