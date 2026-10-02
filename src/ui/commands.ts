import { homedir } from 'node:os'
import { relative } from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { installedPackageNames } from '../companions.ts'
import type { CompanionStatus } from '../companions.ts'
import { personalConfigPath, removePersonalRule, savePersonalRule } from '../config.ts'
import type { Mode, RunwayConfig } from '../config.ts'
import type { ToolIdentity } from '../permissions/operation.ts'
import { ACTIONS, defaultRules, describeRule } from '../permissions/rules.ts'
import type { Action, Rule } from '../permissions/rules.ts'
import type { Policy } from '../policy.ts'
import type { LogEntry, Runtime } from '../runtime.ts'
import { Panel } from './panel.ts'
import type { PanelKey, PanelResult, PanelSection } from './panel.ts'
import { describeTally } from '../trial.ts'

// Everything you see of Runway besides approval dialogs: one quiet status
// item, and /runway for status, permissions, the decision log and a setup check.

export interface UiDeps {
  effectiveMode: (config: RunwayConfig) => Mode
  configFor: (ctx: ExtensionContext) => { config: RunwayConfig; problems: string[] }
  policyFor: (cwd: string, config: RunwayConfig) => Policy
  companions: () => CompanionStatus[]
  identityOf: (tool: string) => ToolIdentity
}

const MODE_TEXT: Record<Mode, string> = {
  auto: 'auto — your rules first, Jev reviews the rest, you have the last word',
  ask: 'ask — your rules first, you review the rest',
  off: 'off — no sandbox and no reviews',
}

export function refreshStatus(ctx: ExtensionContext, rt: Runtime, mode: Mode, progress?: string): void {
  if (!ctx.hasUI) return
  let plain: string
  let color: 'accent' | 'error' | 'warning' | 'success'
  if (progress) [plain, color] = [`runway · ${progress}`, 'accent']
  else if (mode === 'off') [plain, color] = ['runway · off', 'error']
  else if (rt.sandboxState !== 'ready') [plain, color] = [`runway · ${mode} · no sandbox`, 'warning']
  else [plain, color] = [`runway · ${mode}`, mode === 'auto' ? 'success' : 'accent']
  let text = plain
  try {
    // RPC clients have no theme; they get plain text.
    if (ctx.ui.theme) text = ctx.ui.theme.fg(color, plain)
  } catch {
    text = plain
  }
  try {
    ctx.ui.setStatus('runway', text)
  } catch {
    // status is cosmetic
  }
}

function short(path: string): string {
  const home = homedir()
  return path.startsWith(`${home}/`) ? `~/${relative(home, path)}` : path
}

function when(at: string): string {
  return at.slice(11, 19)
}

function entryLine(e: LogEntry): { lead: string; text: string; detail?: string; tone: 'success' | 'danger' | 'normal' } {
  const by = e.by === 'reviewer' ? 'Jev' : e.by === 'person' ? 'you' : e.by === 'unavailable' ? 'nobody to ask' : e.by
  const ms = e.latencyMs !== undefined ? ` · ${e.latencyMs} ms` : ''
  const first = e.summary.split('\n')[0] ?? ''
  return {
    lead: `${when(e.at)} ${e.decision === 'allowed' ? '✓' : '✗'}`,
    text: first.length > 90 ? `${first.slice(0, 89)}…` : first,
    detail: `${e.decision} by ${by}${ms}${e.why && e.decision === 'denied' && e.by !== 'person' ? ` — ${e.why.replace(/^Blocked by [^:]*: /, '').split('. ')[0]}` : ''}`,
    tone: e.decision === 'allowed' ? 'success' : 'danger',
  }
}

const ACTION_WORDS: Record<Action, string> = {
  allow: 'allow — run without asking',
  auto: 'auto — let Jev decide',
  ask: 'ask — always ask me',
  deny: 'deny — never',
}

async function openPanel(ctx: ExtensionContext, build: (done: (r: PanelResult) => void, theme: import('@earendil-works/pi-coding-agent').Theme) => Panel): Promise<PanelResult> {
  return ctx.ui.custom<PanelResult>((tui, theme, _kb, done) => {
    const panel = build(done, theme)
    panel.rows = () => tui.terminal.rows
    return panel
  })
}

function renderText(title: string, sections: PanelSection[]): string {
  const lines = [title]
  for (const s of sections) {
    lines.push('', `${s.title}${s.note ? ` (${s.note})` : ''}`)
    if (!s.rows.length) lines.push(`  ${s.empty ?? 'none'}`)
    for (const r of s.rows) {
      lines.push(`  ${r.id ? `[${r.id}] ` : ''}${r.text}`)
      if (r.detail) lines.push(`      ${r.detail}`)
    }
  }
  return lines.join('\n')
}

export function registerUi(pi: ExtensionAPI, rt: Runtime, deps: UiDeps): void {
  // Quiet by design: decisions you made or saw in a dialog aren't echoed back as notices.
  rt.onRecord = undefined

  const setMode = (ctx: ExtensionContext, mode: Mode) => {
    rt.modeOverride = mode
    const { config } = deps.configFor(ctx)
    if (mode !== 'off' && rt.sandboxState !== 'ready') void rt.ensureSandbox(config, deps.policyFor(ctx.cwd, config)).then(() => refreshStatus(ctx, rt, mode))
    refreshStatus(ctx, rt, mode)
    ctx.ui.notify(`Runway ${MODE_TEXT[mode]}`, mode === 'off' ? 'warning' : 'info')
  }

  // ---------- sections ----------

  const statusSections = (ctx: ExtensionContext): PanelSection[] => {
    const { config } = deps.configFor(ctx)
    const mode = deps.effectiveMode(config)
    const id = ctx.sessionManager.getSessionId()
    const grants = rt.grants.own(id)
    // Subagent sessions started from this one (at any depth).
    const children = rt.tally.sessions().filter(s => s !== id && rt.grants.lineage(s).includes(id))
    return [
      {
        title: 'Now',
        leadWidth: 9,
        rows: [
          { lead: 'Mode', text: MODE_TEXT[mode], tone: mode === 'off' ? 'danger' : 'normal' },
          { lead: 'Sandbox', text: rt.sandboxState === 'ready' ? `on (${process.platform === 'darwin' ? 'macOS Seatbelt' : 'Linux bubblewrap'}) · network ${config.network}` : `not running${rt.sandboxError ? ` — ${rt.sandboxError}` : ''}`, tone: rt.sandboxState === 'ready' ? 'normal' : 'warning' },
          { lead: 'Reviewer', text: rt.reviewerKeyPresent ? 'Jev via OpenRouter' : 'none — you are asked instead (set OPENROUTER_API_KEY or /login to OpenRouter)', tone: rt.reviewerKeyPresent ? 'normal' : 'warning' },
        ],
      },
      { title: 'This session', note: 'counts only, until Pi exits', rows: describeTally(rt.tally.sum([id])).map(text => ({ text, tone: 'muted' as const })) },
      ...(children.length
        ? [{ title: 'Its subagents', note: `${children.length} session${children.length === 1 ? '' : 's'}`, rows: describeTally(rt.tally.sum(children)).map(text => ({ text, tone: 'muted' as const })) }]
        : []),
      {
        title: 'Rules and approvals',
        rows: [{ text: `${grants.length} approval${grants.length === 1 ? '' : 's'} for this session · ${config.permissions.length} saved rule${config.permissions.length === 1 ? '' : 's'}`, tone: 'muted' }],
      },
      { title: 'Recent decisions', note: 'routine allows are not listed', leadWidth: 11, rows: rt.readLog(6).reverse().map(entryLine), empty: 'nothing yet' },
    ]
  }

  const permissionSections = (ctx: ExtensionContext): PanelSection[] => {
    const { config } = deps.configFor(ctx)
    const id = ctx.sessionManager.getSessionId()
    const own = rt.grants.own(id)
    const inherited = rt.grants.inherited(id)
    const personal = config.permissions.filter(r => r.source === 'personal')
    const project = config.permissions.filter(r => r.source === 'project')
    const ruleRow = (r: Rule, selectable: boolean) => ({
      lead: r.action,
      text: describeRule(r),
      detail: r.reason,
      id: selectable ? r.id : undefined,
      tone: (r.action === 'deny' ? 'danger' : r.action === 'allow' ? 'success' : 'normal') as 'danger' | 'success' | 'normal',
    })
    return [
      {
        title: 'This session', note: 'cleared when Pi exits',
        rows: own.map(g => ({ lead: 'allow', text: g.label, detail: g.scope === 'tool' ? 'you allowed the whole tool' : 'you allowed this operation', id: g.id, tone: 'success' as const })),
        empty: 'no approvals yet',
      },
      ...(rt.grants.parentOf(id) ? [{ title: 'From the parent session', note: 'read-only here', rows: inherited.filter(g => g.by === 'person').map(g => ({ lead: 'allow', text: g.label, tone: 'muted' as const })), empty: 'none' }] : []),
      { title: 'Your rules', note: short(personalConfigPath()), rows: personal.map(r => ruleRow(r, true)), empty: 'none yet — press a, or pick "Always allow…" in an approval' },
      ...(project.length ? [{ title: 'Project rules', note: '.pi/runway.json', rows: project.map(r => ruleRow(r, false)) }] : []),
      { title: 'Built-in', note: 'when no rule above decides', rows: defaultRules().map(r => ({ lead: r.action, text: r.summary ?? r.description ?? '', tone: 'muted' as const })) },
    ]
  }

  const doctorSections = (ctx: ExtensionContext): PanelSection[] => {
    const { config, problems } = deps.configFor(ctx)
    const policy = deps.policyFor(ctx.cwd, config)
    const ok = (good: boolean, warn = false) => (good ? 'success' : warn ? 'warning' : 'danger') as 'success' | 'warning' | 'danger'
    const bash = deps.identityOf('bash')
    const rows = [
      { text: `${rt.sandboxState === 'ready' ? '✓' : '✗'} Sandbox ${rt.sandboxState === 'ready' ? 'ready' : 'not running'}`, detail: rt.sandboxError, tone: ok(rt.sandboxState === 'ready') },
      { text: `${bash.kind === 'runway' ? '✓' : '✗'} ${bash.kind === 'runway' ? 'Runway runs the bash tool' : 'Another extension replaced the bash tool'}`, detail: bash.kind === 'runway' ? undefined : `Commands from it are reviewed but not sandboxed by Runway${bash.kind === 'extension' ? ` (${short(bash.path)})` : ''}. Remove the other bash extension.`, tone: ok(bash.kind === 'runway') },
      { text: `${rt.reviewerKeyPresent ? '✓' : '!'} ${rt.reviewerKeyPresent ? 'Reviewer key found (Jev via OpenRouter)' : 'No reviewer key: you are asked instead of Jev'}`, detail: rt.reviewerKeyPresent ? undefined : 'Set OPENROUTER_API_KEY, or /login to OpenRouter, then restart Pi.', tone: ok(rt.reviewerKeyPresent, true) },
      ...deps.companions().map(c => ({
        text: `${c.state === 'loaded' || c.state === 'yours' ? '✓' : c.state === 'off' ? '·' : '!'} ${c.label}: ${c.state === 'loaded' ? `bundled ${c.pkg}@${c.version}` : c.state === 'yours' ? `your own ${c.pkg}` : c.state === 'inactive' ? `your ${c.pkg} is listed but not loaded` : c.state === 'off' ? 'switched off' : c.state}`,
        detail: c.detail,
        tone: ok(c.state === 'loaded' || c.state === 'yours' || c.state === 'off', true),
      })),
      ...coexistence(ctx),
      ...problems.map(p => ({ text: '✗ Settings problem', detail: p, tone: 'danger' as const })),
    ]
    return [
      { title: 'Checks', rows },
      { title: 'Where', rows: [
        { text: `Project   ${short(policy.workspace)}${policy.git?.linked ? '  (linked git worktree)' : ''}`, tone: 'muted' },
        { text: `Settings   ${short(personalConfigPath())}`, tone: 'muted' },
        { text: `Decision log   ${short(rt.logPath())}`, tone: 'muted' },
      ] },
    ]
  }

  const coexistence = (ctx: ExtensionContext) => {
    let trusted = false
    try {
      trusted = ctx.isProjectTrusted()
    } catch {
      trusted = false
    }
    const names = installedPackageNames(rt.agentDir, ctx.cwd, trusted)
    const rows: { text: string; detail: string; tone: 'warning' }[] = []
    if (names.has('@gotgenes/pi-permission-system')) rows.push({ text: '! pi-permission-system is also installed', detail: 'Its own "ask" rules prompt before Runway decides, and its reviewer link is separate. Runway covers the same ground; remove it, or set its rules to allow.', tone: 'warning' })
    if (names.has('pi-auto-review-jev')) rows.push({ text: '! pi-auto-review-jev is also installed', detail: 'Runway already sends undecided calls to Jev. Remove the separate package to avoid double reviews.', tone: 'warning' })
    if ([...names].some(n => /pi-.*sandbox/.test(n))) rows.push({ text: '! another sandbox package is installed', detail: 'If it replaces bash, Runway cannot sandbox commands. Remove it.', tone: 'warning' })
    return rows
  }

  // ---------- flows ----------

  const addRule = async (ctx: ExtensionContext): Promise<void> => {
    const actionLabel = await ctx.ui.select('New rule — what should happen?', ACTIONS.map(a => ACTION_WORDS[a]))
    const action = ACTIONS.find(a => ACTION_WORDS[a] === actionLabel)
    if (!action) return
    const tool = (await ctx.ui.input('Which tool? (bash, read, write, fetch_content, mcp__server__tool, or * for any; globs work)', 'bash'))?.trim()
    if (!tool) return
    const kinds = tool === 'bash' ? ['command pattern', 'any call of this tool'] : ['any call of this tool', 'path pattern', 'host pattern']
    const kind = await ctx.ui.select(`Match ${tool} calls by`, kinds)
    if (!kind) return
    const rule: Omit<Rule, 'id' | 'source'> = { action, tool }
    if (kind !== 'any call of this tool') {
      const hint = kind === 'command pattern' ? 'git push --force*' : kind === 'path pattern' ? 'src/** or ~/notes/**' : '*.example.com'
      const pattern = (await ctx.ui.input(`${kind[0]!.toUpperCase()}${kind.slice(1)} (* matches anything)`, hint))?.trim()
      if (!pattern) return
      if (kind === 'command pattern') rule.command = pattern
      else if (kind === 'path pattern') rule.path = pattern
      else rule.host = pattern
    }
    if (action === 'deny' || action === 'ask') {
      const reason = (await ctx.ui.input('Reason the agent will see (optional)', ''))?.trim()
      if (reason) rule.reason = reason
    }
    const preview = `${action} ${describeRule({ ...rule, id: '', source: 'personal' })}${rule.reason ? ` — ${rule.reason}` : ''}`
    const confirmed = await ctx.ui.confirm('Save this rule?', `${preview}\n\nSaved to ${short(personalConfigPath())}.`)
    if (!confirmed) return
    try {
      savePersonalRule(rule)
      rt.configGeneration += 1
      ctx.ui.notify(`Saved: ${preview}`, 'info')
    } catch (error) {
      ctx.ui.notify(`Could not save: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const removeRule = async (ctx: ExtensionContext, id: string): Promise<void> => {
    const { config } = deps.configFor(ctx)
    const rule = config.permissions.find(r => r.id === id && r.source === 'personal')
    if (!rule) return
    const ok = await ctx.ui.confirm('Remove this rule?', `${rule.action} ${describeRule(rule)}`)
    if (!ok) return
    if (removePersonalRule(Number(id.slice(1)) - 1)) {
      rt.configGeneration += 1
      ctx.ui.notify(`Removed: ${rule.action} ${describeRule(rule)}`, 'info')
    }
  }

  const permissionsCommand = async (ctx: ExtensionCommandContext, args: string[]): Promise<void> => {
    const id = ctx.sessionManager.getSessionId()
    const [sub, ...rest] = args
    if (sub === 'reset') {
      const n = rt.grants.reset(id)
      ctx.ui.notify(`Runway: cleared ${n} approval${n === 1 ? '' : 's'} for this session.`, 'info')
      return
    }
    if (sub === 'revoke' && rest[0]) {
      ctx.ui.notify(rt.grants.revoke(id, rest[0]) ? `Revoked ${rest[0]}.` : `No approval ${rest[0]} in this session.`, 'info')
      return
    }
    if (sub === 'remove' && rest[0]) return removeRule(ctx, rest[0])
    if (sub === 'add' && rest.length >= 2 && (ACTIONS as readonly string[]).includes(rest[0]!)) {
      const rule: Omit<Rule, 'id' | 'source'> = { action: rest[0] as Action, tool: rest[1] }
      for (const part of rest.slice(2)) {
        const m = /^(command|path|host|reason)=(.+)$/.exec(part)
        if (m) rule[m[1] as 'command'] = m[2]!.replace(/^["']|["']$/g, '')
      }
      savePersonalRule(rule)
      rt.configGeneration += 1
      ctx.ui.notify(`Saved: ${rule.action} ${describeRule({ ...rule, id: '', source: 'personal' })}`, 'info')
      return
    }
    if (sub === 'add' && ctx.hasUI) return addRule(ctx)
    if (ctx.mode !== 'tui') {
      ctx.ui.notify(renderText('Runway permissions', permissionSections(ctx)) + '\n\n/runway permissions add <allow|auto|ask|deny> <tool> [command=…|path=…|host=…] [reason=…] · remove p<n> · revoke g<n> · reset', 'info')
      return
    }
    let focus: string | undefined
    for (;;) {
      const keys: PanelKey[] = [
        { key: 'a', label: 'add rule' },
        { key: 'd', label: 'revoke / remove', needsSelection: true },
        { key: 'r', label: 'reset session' },
      ]
      const result = await openPanel(ctx, (done, theme) => new Panel(theme, 'Runway permissions', 'your rules decide first; Jev reviews the rest', permissionSections(ctx), keys, done, focus))
      if (!result) return
      focus = result.id
      if (result.key === 'a') await addRule(ctx)
      else if (result.key === 'r') {
        if (await ctx.ui.confirm('Clear this session\'s approvals?', 'Saved rules stay.')) rt.grants.reset(id)
      } else if (result.key === 'd' && result.id) {
        if (result.id.startsWith('g')) rt.grants.revoke(id, result.id)
        else await removeRule(ctx, result.id)
        focus = undefined
      }
    }
  }

  pi.registerCommand('runway', {
    description: 'Runway: status · permissions · log · doctor · auto | ask | off',
    getArgumentCompletions: prefix =>
      ['status', 'permissions', 'log', 'doctor', 'auto', 'ask', 'off']
        .filter(item => item.startsWith(prefix.trim()))
        .map(item => ({ value: item, label: item })),
    handler: async (raw: string, ctx: ExtensionCommandContext) => {
      const args = raw.trim().split(/\s+/).filter(Boolean)
      const [sub = 'status', ...rest] = args
      if (sub === 'auto' || sub === 'ask') return setMode(ctx, sub)
      if (sub === 'off') {
        if (await ctx.ui.confirm('Turn Runway off?', 'Commands will run without the sandbox and without any review — with your full access — until you turn it back on or restart Pi.')) setMode(ctx, 'off')
        return
      }
      if (sub === 'permissions' || sub === 'perms' || sub === 'rules') return permissionsCommand(ctx, rest)
      if (sub === 'log') {
        const n = Math.min(Math.max(Number(rest[0]) || 30, 1), 500)
        const sections: PanelSection[] = [{ title: `Last ${n} decisions`, note: 'routine allows are not logged', leadWidth: 11, rows: rt.readLog(n).reverse().map(entryLine), empty: 'nothing has needed a decision yet' }]
        if (ctx.mode !== 'tui') return ctx.ui.notify(renderText('Runway log', sections), 'info')
        await openPanel(ctx, (done, theme) => new Panel(theme, 'Runway log', short(rt.logPath()), sections, [], done))
        return
      }
      if (sub === 'doctor') {
        const sections = doctorSections(ctx)
        if (ctx.mode !== 'tui') return ctx.ui.notify(renderText('Runway doctor', sections), 'info')
        await openPanel(ctx, (done, theme) => new Panel(theme, 'Runway doctor', undefined, sections, [], done))
        return
      }
      const sections = statusSections(ctx)
      if (ctx.mode !== 'tui') return ctx.ui.notify(renderText('Runway', sections), 'info')
      const result = await openPanel(ctx, (done, theme) => new Panel(theme, 'Runway', 'safe autonomy for Pi', sections, [
        { key: 'p', label: 'permissions' },
        { key: 'l', label: 'log' },
        { key: 'd', label: 'doctor' },
        { key: 'm', label: 'switch auto/ask' },
      ], done))
      if (!result) return
      if (result.key === 'p') return permissionsCommand(ctx, [])
      if (result.key === 'm') return setMode(ctx, deps.effectiveMode(deps.configFor(ctx).config) === 'auto' ? 'ask' : 'auto')
      const next = result.key === 'l' ? 'log' : 'doctor'
      const sectionsNext = next === 'log' ? [{ title: 'Last 30 decisions', note: 'routine allows are not logged', leadWidth: 11, rows: rt.readLog(30).reverse().map(entryLine), empty: 'nothing yet' }] : doctorSections(ctx)
      await openPanel(ctx, (done, theme) => new Panel(theme, next === 'log' ? 'Runway log' : 'Runway doctor', undefined, sectionsNext, [], done))
    },
  })

  pi.registerShortcut('ctrl+shift+a', {
    description: 'Runway: switch between Jev reviewing (auto) and you reviewing (ask)',
    handler: async ctx => {
      const current = deps.effectiveMode(deps.configFor(ctx).config)
      setMode(ctx, current === 'auto' ? 'ask' : 'auto')
    },
  })
}
