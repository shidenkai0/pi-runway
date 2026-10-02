import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Mode, RunwayConfig } from './config.ts'
import { personalConfigPath } from './config.ts'
import type { Policy } from './policy.ts'
import type { LogEntry, Runtime } from './runtime.ts'

// What the user sees: a status line, /runway, a shortcut, and a short notice
// whenever something leaves the sandbox.

export interface UiDeps {
  effectiveMode: (config: RunwayConfig) => Mode
  configFor: (ctx: ExtensionContext) => RunwayConfig
  policyFor: (cwd: string, config: RunwayConfig) => Policy
}

const MODE_TEXT: Record<Mode, string> = {
  auto: 'auto — sandboxed; Jev reviews anything that leaves the sandbox (approved commands run with your full access)',
  ask: 'ask — sandboxed; you review anything that leaves the sandbox',
  off: 'off — no sandbox, no reviews',
}

export function statusText(rt: Runtime, mode: Mode): { text: string; color: 'success' | 'warning' | 'error' | 'accent' } {
  if (mode === 'off') return { text: 'runway off', color: 'error' }
  if (rt.sandboxState !== 'ready') return { text: `runway ${mode} · no sandbox`, color: 'warning' }
  if (mode === 'auto') return { text: 'runway auto', color: 'success' }
  return { text: 'runway ask', color: 'accent' }
}

export function refreshStatus(ctx: ExtensionContext, rt: Runtime, mode: Mode): void {
  if (!ctx.hasUI) return
  const { text, color } = statusText(rt, mode)
  try {
    ctx.ui.setStatus('runway', ctx.ui.theme.fg(color, text))
  } catch {
    ctx.ui.setStatus('runway', text)
  }
}

function formatEntry(e: LogEntry): string {
  const time = e.at.slice(11, 19)
  const by = e.by === 'reviewer' ? 'Jev' : e.by
  const ms = e.latencyMs !== undefined ? ` · ${e.latencyMs} ms` : ''
  const what = e.kind === 'command' && e.decision === 'allowed' ? 'command (ran outside the sandbox)' : e.kind
  return `${time} ${e.decision === 'allowed' ? '✓' : '✗'} ${what} by ${by}${ms}: ${e.summary.split('\n')[0]?.slice(0, 120) ?? ''}`
}

/** Our bash tool is the one that accepts `escalate`. */
export function isRunwayBash(parameters: unknown): boolean {
  const props = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return Boolean(props && 'escalate' in props && 'justification' in props)
}

interface Check {
  ok: boolean | 'warn'
  label: string
  detail?: string
}

function readSettingsPackages(agentDir: string): string[] {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')) as { packages?: unknown[] }
    return (settings.packages ?? []).map(p => (typeof p === 'string' ? p : typeof p === 'object' && p && 'source' in p ? String((p as { source: unknown }).source) : '')).filter(Boolean)
  } catch {
    return []
  }
}

export function doctor(pi: ExtensionAPI, rt: Runtime, ctx: ExtensionContext, deps: UiDeps): Check[] {
  const config = deps.configFor(ctx)
  const mode = deps.effectiveMode(config)
  const checks: Check[] = []
  checks.push({ ok: mode !== 'off', label: `Mode: ${MODE_TEXT[mode]}` })
  checks.push({
    ok: rt.sandboxState === 'ready',
    label: rt.sandboxState === 'ready' ? `Sandbox ready (${process.platform === 'darwin' ? 'macOS Seatbelt' : 'Linux bubblewrap'}), network: ${config.network}` : 'Sandbox not running',
    detail: rt.sandboxError,
  })
  checks.push({
    ok: rt.reviewerKeyPresent ? true : 'warn',
    label: rt.reviewerKeyPresent ? 'Reviewer key found (Jev via OpenRouter)' : 'No reviewer key: escalations go to you instead of Jev',
    detail: rt.reviewerKeyPresent ? undefined : 'Set OPENROUTER_API_KEY, or log in to OpenRouter in Pi (/login), then restart Pi.',
  })
  // Who owns the tools we rely on.
  try {
    const tools = pi.getAllTools()
    const bash = tools.find(t => t.name === 'bash')
    const owner = bash?.sourceInfo?.path ?? ''
    const ours = isRunwayBash(bash?.parameters)
    checks.push({
      ok: ours,
      label: ours ? 'Runway runs the bash tool' : `Another extension replaced the bash tool (${owner || 'unknown'})`,
      detail: ours ? undefined : 'Commands are not sandboxed by Runway. Remove the other bash extension (for example the example "sandbox" extension) from your Pi setup.',
    })
  } catch {
    checks.push({ ok: 'warn', label: 'Could not inspect tool ownership' })
  }
  const packages = readSettingsPackages(rt.agentDir)
  if (packages.some(p => p.includes('pi-permission-system'))) {
    checks.push({ ok: 'warn', label: 'pi-permission-system is installed', detail: 'Its "ask" rules still prompt before Runway sees a command. Runway replaces it; consider removing it or setting its bash rule to allow.' })
  }
  if (packages.some(p => p.includes('pi-auto-review-jev'))) {
    checks.push({ ok: 'warn', label: 'pi-auto-review-jev is installed', detail: 'Runway includes Jev review. Remove the separate package to avoid double reviews.' })
  }
  for (const problem of rt.configProblems) checks.push({ ok: false, label: 'Settings problem', detail: problem })
  const policy = deps.policyFor(ctx.cwd, config)
  checks.push({ ok: true, label: `Project: ${policy.workspace}${policy.git?.linked ? ' (linked git worktree)' : ''}` })
  checks.push({ ok: true, label: `Settings file: ${personalConfigPath()}` })
  return checks
}

export function registerUi(pi: ExtensionAPI, rt: Runtime, deps: UiDeps): void {
  rt.onRecord = entry => {
    const session = rt.sessions.get(entry.session)
    const person = session?.hasUI ? session : rt.personFor(entry.session)
    if (!person?.hasUI) return
    const line = formatEntry(entry)
    person.ctx.ui.notify(`Runway ${line}`, entry.decision === 'allowed' ? 'info' : 'warning')
  }

  const setMode = (ctx: ExtensionContext, mode: Mode) => {
    rt.modeOverride = mode
    rt.lastMode = mode
    const config = deps.configFor(ctx)
    if (mode !== 'off' && rt.sandboxState !== 'ready') void rt.ensureSandbox(config, deps.policyFor(ctx.cwd, config)).then(() => refreshStatus(ctx, rt, mode))
    refreshStatus(ctx, rt, mode)
    ctx.ui.notify(`Runway ${MODE_TEXT[mode]}`, mode === 'off' ? 'warning' : 'info')
  }

  pi.registerCommand('runway', {
    description: 'Runway: status, mode (auto | ask | off), log, doctor',
    getArgumentCompletions: prefix =>
      ['status', 'auto', 'ask', 'off', 'log', 'doctor']
        .filter(item => item.startsWith(prefix.trim()))
        .map(item => ({ value: item, label: item })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub = 'status', arg] = args.trim().split(/\s+/)
      const config = deps.configFor(ctx)
      if (sub === 'auto' || sub === 'ask') return setMode(ctx, sub)
      if (sub === 'off') {
        const sure = await ctx.ui.confirm('Turn Runway off?', 'Commands will run with full access to your machine, without review, until you turn it back on or restart Pi.')
        if (sure) setMode(ctx, 'off')
        return
      }
      if (sub === 'log') {
        const n = Math.min(Math.max(Number(arg) || 20, 1), 200)
        const entries = rt.readLog(n)
        ctx.ui.notify(entries.length ? entries.map(formatEntry).join('\n') : 'Runway: nothing has left the sandbox yet.', 'info')
        return
      }
      if (sub === 'doctor') {
        const checks = doctor(pi, rt, ctx, deps)
        const lines = checks.map(c => `${c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗'} ${c.label}${c.detail ? `\n    ${c.detail}` : ''}`)
        ctx.ui.notify(lines.join('\n'), checks.some(c => c.ok === false) ? 'warning' : 'info')
        return
      }
      const mode = deps.effectiveMode(config)
      const grants = [...rt.grantedHosts].map(h => `host ${h}`).concat([...rt.grantedWriteRoots].map(p => `writes in ${p}`), [...rt.grantedReadPaths].map(p => `reading ${p}`))
      const recent = rt.readLog(5)
      ctx.ui.notify(
        [
          `Runway ${MODE_TEXT[mode]}`,
          `Sandbox: ${rt.sandboxState === 'ready' ? `on · network ${config.network}` : `not running${rt.sandboxError ? ` (${rt.sandboxError})` : ''}`}`,
          `Reviewer: ${rt.reviewerKeyPresent ? 'Jev' : 'none (you review)'}${config.onDeny === 'ask' ? ' · denials ask you' : ''}`,
          grants.length ? `Allowed this session: ${grants.join(', ')}` : undefined,
          recent.length ? `Recent:\n${recent.map(formatEntry).join('\n')}` : undefined,
          'Commands: /runway auto | ask | off | log | doctor · shortcut ctrl+shift+a switches auto/ask',
        ].filter(Boolean).join('\n'),
        'info',
      )
    },
  })

  pi.registerShortcut('ctrl+shift+a', {
    description: 'Runway: switch between auto review and asking you',
    handler: async ctx => {
      const config = deps.configFor(ctx)
      const current = deps.effectiveMode(config)
      setMode(ctx, current === 'auto' ? 'ask' : 'auto')
    },
  })
}
