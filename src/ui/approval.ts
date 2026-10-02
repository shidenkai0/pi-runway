import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { DynamicBorder, keyHint, rawKeyHint } from '@earendil-works/pi-coding-agent'
import type { Component, Focusable } from '@earendil-works/pi-tui'
import { getKeybindings, Input } from '@earendil-works/pi-tui'
import { capLines, clip, hang, hintLines, safe } from './text.ts'
import { describeRule } from '../permissions/rules.ts'
import type { ScopeChoice } from '../permissions/suggest.ts'

// The approval dialog. It reads top to bottom the way a person decides:
// who wants to do what, where it runs, why you are being asked, then the
// choices — narrowest first, with Escape always meaning "no".

export type Tone = 'normal' | 'warning' | 'danger'

export interface ApprovalRequest {
  /** Small caption on the right of the title: the tool name. */
  tool: string
  /** "The agent" or `Subagent "worker"`. */
  who: string
  /** What it wants to do, as a verb phrase: "run a command", "read a file", "use github (MCP)". */
  verb?: string
  /** The action itself, one or more lines (command, path, URL, MCP call…). */
  action: string[]
  /** Working directory, shown under the action when it helps. */
  where?: string
  /** Why you are asked (reviewer said no, a rule, a built-in safeguard…). */
  why: string
  whyTone: Tone
  /** How it will run if allowed. */
  runs: string
  runsTone: Tone
  sessionOpLabel: string
  /** Undefined hides "allow the whole tool for this session". */
  sessionToolLabel?: string
  saveScopes: ScopeChoice[]
  /** Put the focus on Deny (the reviewer already said no). */
  focusDeny?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

export type ApprovalChoice =
  | { kind: 'once' }
  | { kind: 'session-op' }
  | { kind: 'session-tool' }
  | { kind: 'save'; scope: ScopeChoice }
  | { kind: 'deny'; reason?: string }

interface Option {
  label: string
  hint?: string
  choice?: ApprovalChoice
  step?: 'save' | 'reason' | 'back'
  tone?: Tone
}

function mainOptions(req: ApprovalRequest): Option[] {
  const opts: Option[] = [
    { label: 'Allow once', choice: { kind: 'once' } },
    { label: `Allow for this session: ${req.sessionOpLabel}`, choice: { kind: 'session-op' } },
  ]
  if (req.sessionToolLabel) opts.push({ label: req.sessionToolLabel, choice: { kind: 'session-tool' }, tone: 'warning' })
  if (req.saveScopes.length) opts.push({ label: 'Always allow…', hint: 'save a rule', step: 'save' })
  opts.push({ label: 'Deny', choice: { kind: 'deny' } })
  opts.push({ label: 'Deny and tell the agent why…', step: 'reason' })
  return opts
}

function saveOptions(req: ApprovalRequest): Option[] {
  return [
    ...req.saveScopes.map(scope => ({
      label: scope.label,
      hint: `allow ${describeRule({ ...scope.rule, id: '', source: 'personal' })}`,
      choice: { kind: 'save', scope } as ApprovalChoice,
      tone: scope.broad ? ('warning' as const) : undefined,
    })),
    { label: '← Back', step: 'back' as const },
  ]
}

function tone(theme: Theme, t: Tone | undefined, text: string): string {
  if (t === 'danger') return theme.fg('error', text)
  if (t === 'warning') return theme.fg('warning', text)
  return theme.fg('text', text)
}

/** Every string a dialog shows comes from the agent or a tool: made safe to draw once, up front. */
export function sanitizeRequest(req: ApprovalRequest): ApprovalRequest {
  return {
    ...req,
    tool: safe(req.tool),
    who: safe(req.who),
    action: req.action.flatMap(l => safe(l).split('\n')),
    where: req.where === undefined ? undefined : safe(req.where),
    why: safe(req.why),
    runs: safe(req.runs),
    sessionOpLabel: safe(req.sessionOpLabel),
    saveScopes: req.saveScopes.map(s => ({ ...s, label: safe(s.label) })),
  }
}

/**
 * The approval dialog. Its height always fits the terminal: the decisions
 * and the "why" stay visible, and the action gets the room that is left.
 * When the action doesn't fit, `v` opens all of it in a scrollable view.
 */
export class ApprovalDialog implements Component, Focusable {
  private screen: 'main' | 'save' | 'reason' | 'details' = 'main'
  private index = 0
  private scroll = 0
  private options: Option[]
  private readonly input: Input
  private readonly req: ApprovalRequest
  private readonly theme: Theme
  private readonly rows: () => number
  private readonly done: (choice: ApprovalChoice) => void
  private readonly border: DynamicBorder
  private actionClipped = false
  private detailsPage = 10
  private _focused = false

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.input.focused = value && this.screen === 'reason'
  }

  constructor(req: ApprovalRequest, theme: Theme, done: (choice: ApprovalChoice) => void, rows: () => number = () => 40) {
    this.req = sanitizeRequest(req)
    this.theme = theme
    this.done = done
    this.rows = rows
    this.options = mainOptions(this.req)
    if (req.focusDeny) this.index = Math.max(0, this.options.findIndex(o => o.choice?.kind === 'deny'))
    this.border = new DynamicBorder(req.runsTone === 'danger' ? (s: string) => theme.fg('error', s) : undefined)
    this.input = new Input({ placeholder: 'Reason the agent will see' } as never)
    this.input.onSubmit = value => this.done({ kind: 'deny', reason: value.trim() || undefined })
    this.input.onEscape = () => this.show('main')
  }

  invalidate(): void {
    this.border.invalidate()
    this.input.invalidate()
  }

  /** The most rows the dialog may take: most of the screen, leaving the conversation a little room. */
  private budget(): number {
    const rows = Math.max(8, this.rows() || 40)
    // Pi's footer below the dialog takes about four rows. Small terminals get
    // the rest; large ones also leave the conversation some room.
    return rows <= 20 ? rows - 4 : Math.min(rows - 5, Math.floor(rows * 0.8))
  }

  render(width: number): string[] {
    const t = this.theme
    const w = Math.max(1, width)
    const top = this.border.render(w)
    const headline = `${this.req.who} wants to ${this.req.verb ?? 'use a tool'}`
    const head = [clip('', `${t.fg('accent', t.bold(headline))}  ${t.fg('muted', this.req.tool)}`, w)]
    const actionLines = this.req.action.flatMap(l => hang('', t.fg('toolOutput', l), w, 3))
    const where = this.req.where ? [clip('   ', t.fg('dim', `in ${this.req.where}`), w)] : []
    const why = hang(t.fg('muted', 'Why   '), tone(t, this.req.whyTone, this.req.why), w)
    const runs = hang(t.fg('muted', 'Runs  '), tone(t, this.req.runsTone, this.req.runs), w)
    const budget = this.budget()

    if (this.screen === 'details') {
      const body = [...actionLines, ...where, '', ...why, ...runs]
      const keys = hintLines([rawKeyHint('↑↓', 'scroll'), rawKeyHint('PgUp PgDn', 'page'), keyHint('tui.select.cancel', 'back')], w)
      const page = Math.max(3, budget - 5 - keys.length)
      this.detailsPage = page
      this.scroll = Math.min(Math.max(0, this.scroll), Math.max(0, body.length - page))
      const end = Math.min(body.length, this.scroll + page)
      const position = body.length > page ? `lines ${this.scroll + 1}–${end} of ${body.length}` : 'all of it'
      return [
        ...top,
        clip('', `${t.fg('accent', t.bold('The full request'))}  ${t.fg('muted', position)}`, w),
        '',
        ...body.slice(this.scroll, end),
        '',
        ...keys,
        ...top,
      ]
    }

    // Fixed parts first; the decisions are never squeezed out. On a short
    // terminal the layout tightens: no blank lines, a shorter "why", no hints
    // under options. The action gets whatever room is left (at least a line).
    const more = clip('       ', t.fg('dim', '… (v shows all)'), w)
    const layout = (compact: boolean) => {
      const list = this.listLines(w, compact)
      const capWhy = capLines(why, compact ? 1 : 4, more)
      const capRuns = capLines(runs, compact ? (budget >= 12 ? 2 : 1) : 3, more)
      const gap = compact ? [] : ['']
      const fixed = top.length * 2 + head.length + gap.length * 4 + where.length + capWhy.length + capRuns.length + list.length + 1
      return { list, capWhy, capRuns, gap, fixed }
    }
    let l = layout(false)
    if (budget - l.fixed < 2) l = layout(true)
    const room = Math.max(1, Math.min(12, budget - l.fixed))
    this.actionClipped = actionLines.length > room || l.capWhy !== why || l.capRuns !== runs
    const keep = Math.max(1, room - 1)
    const shown = actionLines.length > room ? [...actionLines.slice(0, keep), clip('   ', t.fg('dim', `… ${actionLines.length - keep} more lines · v to see all`), w)] : actionLines
    // The most useful keys come first, so the ones that don't fit are the least needed.
    const hints = hintLines(this.hintParts(), w).slice(0, l.gap.length ? 2 : 1)
    const body = [...head, ...l.gap, ...shown, ...where, ...l.gap, ...l.capWhy, ...l.capRuns, ...l.gap, ...l.list, ...l.gap, ...hints]
    // Last resort on a tiny terminal: the borders go before any content does.
    return body.length + top.length * 2 <= budget ? [...top, ...body, ...top] : body
  }

  private listLines(w: number, compact = false): string[] {
    const t = this.theme
    if (this.screen === 'reason') {
      return [...hang('', t.fg('accent', 'Why not? The agent will see your answer.'), w), ...this.input.render(w)]
    }
    const out: string[] = []
    if (this.screen === 'save') out.push(...hang('', t.fg('muted', 'Save a rule to your Runway settings. Review or remove it any time with /runway permissions.'), w))
    this.options.forEach((opt, i) => {
      const selected = i === this.index
      const num = opt.step === 'back' ? ' ' : `${i + 1}`
      const label = selected ? t.fg('accent', opt.label) : tone(t, opt.tone, opt.label)
      const prefix = selected ? t.fg('accent', `→ ${num} `) : t.fg('dim', `  ${num} `)
      out.push(...capLines(hang(prefix, label, w), compact ? 1 : 2, `${' '.repeat(5)}${t.fg('dim', '…')}`))
      // The exact rule a scope saves stays visible for the selected one, however tight the space.
      if (opt.hint && (selected || (!compact && this.screen === 'save'))) out.push(clip('      ', t.fg('dim', opt.hint), w))
    })
    return out
  }

  private hintParts(): string[] {
    if (this.screen === 'reason') return [keyHint('tui.select.confirm', 'deny with this reason'), keyHint('tui.select.cancel', 'back')]
    const numbered = this.options.filter(o => o.step !== 'back').length
    const parts = [rawKeyHint('↑↓', 'choose'), keyHint('tui.select.confirm', 'confirm'), keyHint('tui.select.cancel', this.screen === 'main' ? 'deny' : 'back')]
    // Arrows and Enter are what everyone tries first; "v" is the one to be told about.
    if (this.screen === 'main' && this.actionClipped) parts.unshift(rawKeyHint('v', 'view all'))
    parts.push(rawKeyHint(`1-${Math.min(9, numbered)}`, 'pick'))
    return parts
  }

  private show(screen: 'main' | 'save' | 'reason' | 'details'): void {
    const from = this.screen
    this.screen = screen
    if (screen === 'details') this.scroll = 0
    else if (screen !== 'main' || from !== 'details') {
      this.options = screen === 'main' ? mainOptions(this.req) : screen === 'save' ? saveOptions(this.req) : []
      this.index = screen === 'main' && this.req.focusDeny ? Math.max(0, this.options.findIndex(o => o.choice?.kind === 'deny')) : 0
    }
    this.input.focused = this._focused && screen === 'reason'
  }

  private activate(opt: Option | undefined): void {
    if (!opt) return
    if (opt.step === 'save') return this.show('save')
    if (opt.step === 'reason') return this.show('reason')
    if (opt.step === 'back') return this.show('main')
    if (opt.choice) this.done(opt.choice)
  }

  handleInput(data: string): void {
    const kb = getKeybindings()
    if (this.screen === 'reason') {
      this.input.handleInput(data)
      return
    }
    if (this.screen === 'details') {
      if (kb.matches(data, 'tui.select.up') || data === 'k') this.scroll -= 1
      else if (kb.matches(data, 'tui.select.down') || data === 'j') this.scroll += 1
      else if (kb.matches(data, 'tui.select.pageUp') || data === '\x1b[5~' || data === 'b') this.scroll -= this.detailsPage
      else if (kb.matches(data, 'tui.select.pageDown') || data === '\x1b[6~' || data === ' ') this.scroll += this.detailsPage
      else if (data === 'g' || data === '\x1b[H') this.scroll = 0
      else if (data === 'G' || data === '\x1b[F') this.scroll = Number.MAX_SAFE_INTEGER
      else if (kb.matches(data, 'tui.select.cancel') || kb.matches(data, 'tui.select.confirm') || data === 'v' || data === 'q') this.show('main')
      return
    }
    if (kb.matches(data, 'tui.select.up') || data === 'k') {
      this.index = (this.index - 1 + this.options.length) % this.options.length
    } else if (kb.matches(data, 'tui.select.down') || data === 'j') {
      this.index = (this.index + 1) % this.options.length
    } else if (kb.matches(data, 'tui.select.confirm') || data === '\n') {
      this.activate(this.options[this.index])
    } else if (kb.matches(data, 'tui.select.cancel')) {
      if (this.screen === 'main') this.done({ kind: 'deny' })
      else this.show('main')
    } else if (data === 'v' && this.screen === 'main') {
      this.show('details')
    } else if (/^[1-9]$/.test(data)) {
      const opt = this.options[Number(data) - 1]
      if (opt) {
        this.index = Number(data) - 1
        this.activate(opt)
      }
    }
  }
}

/** Plain-dialog version for RPC clients and other non-terminal UIs. */
async function approveWithSelect(ctx: ExtensionContext, raw: ApprovalRequest): Promise<ApprovalChoice | undefined> {
  const req = sanitizeRequest(raw)
  // The whole action: an RPC client shows the title as it likes, and nothing is hidden from the person deciding.
  const title = [
    `${req.who} wants to ${req.verb ?? 'use a tool'} (${req.tool}):`,
    ...req.action,
    req.where ? `in ${req.where}` : undefined,
    '',
    `Why: ${req.why}`,
    `Runs: ${req.runs}`,
  ].filter((l): l is string => l !== undefined).join('\n')
  const opts = mainOptions(req)
  const picked = await ctx.ui.select(title, opts.map(o => o.label), { signal: req.signal, timeout: req.timeoutMs })
  const opt = opts.find(o => o.label === picked)
  if (!opt) return picked === undefined && req.signal?.aborted ? undefined : { kind: 'deny' }
  if (opt.choice) return opt.choice
  if (opt.step === 'reason') {
    const reason = await ctx.ui.input('Why are you denying this? The agent will see your answer.', 'reason')
    return { kind: 'deny', reason: reason?.trim() || undefined }
  }
  if (opt.step === 'save') {
    const scopes = saveOptions(req).filter(o => o.choice)
    const label = await ctx.ui.select('Always allow — save which rule?', scopes.map(s => `${s.label}  (allow ${s.hint?.replace(/^allow /, '')})`), { signal: req.signal })
    const scope = scopes.find(s => label?.startsWith(s.label))
    return scope?.choice ?? { kind: 'deny' }
  }
  return { kind: 'deny' }
}

/**
 * Ask a person. Full dialog in the terminal UI, plain choices elsewhere,
 * undefined when nobody can be asked (the caller then refuses).
 */
export async function requestApproval(ctx: ExtensionContext, req: ApprovalRequest): Promise<ApprovalChoice | undefined> {
  if (!ctx.hasUI) return undefined
  if (req.signal?.aborted) return undefined
  if (ctx.mode !== 'tui') return approveWithSelect(ctx, req)
  try {
    const result = await ctx.ui.custom<ApprovalChoice | undefined>((tui, theme, _kb, done) => {
      const dialog = new ApprovalDialog(req, theme, choice => done(choice), () => tui.terminal.rows)
      let timer: NodeJS.Timeout | undefined
      const onAbort = () => done(undefined)
      req.signal?.addEventListener('abort', onAbort, { once: true })
      if (req.timeoutMs) timer = setTimeout(() => done({ kind: 'deny', reason: 'No answer in time.' }), req.timeoutMs)
      return Object.assign(dialog, {
        dispose: () => {
          if (timer) clearTimeout(timer)
          req.signal?.removeEventListener('abort', onAbort)
        },
      }) as Component & { dispose(): void }
    })
    return result
  } catch {
    return approveWithSelect(ctx, req)
  }
}
