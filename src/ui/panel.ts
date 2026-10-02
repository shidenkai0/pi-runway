import type { Theme } from '@earendil-works/pi-coding-agent'
import { DynamicBorder, keyHint, rawKeyHint } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { getKeybindings } from '@earendil-works/pi-tui'
import { clip, hang, hintLines, safe } from './text.ts'

// A read-and-act panel in Pi's own style: sections of rows, some of which can
// be selected and acted on with a key. Used by /runway and /runway permissions.

export interface PanelRow {
  /** Optional left column (e.g. the rule's action); wrapped text hangs beside it. */
  lead?: string
  text: string
  /** Second line, dimmed. */
  detail?: string
  /** Selectable rows carry an id the caller acts on. */
  id?: string
  tone?: 'normal' | 'muted' | 'warning' | 'danger' | 'success'
}

export interface PanelSection {
  /** Width of the left column for rows with a `lead` (default 6). */
  leadWidth?: number
  title: string
  note?: string
  rows: PanelRow[]
  empty?: string
}

export interface PanelKey {
  key: string
  label: string
  /** Needs a selected row. */
  needsSelection?: boolean
}

export type PanelResult = { key: string; id?: string } | undefined

function paint(theme: Theme, tone: PanelRow['tone'], text: string): string {
  switch (tone) {
    case 'muted':
      return theme.fg('muted', text)
    case 'warning':
      return theme.fg('warning', text)
    case 'danger':
      return theme.fg('error', text)
    case 'success':
      return theme.fg('success', text)
    default:
      return theme.fg('text', text)
  }
}

/**
 * The panel keeps to the terminal's height: the title and the keys stay put,
 * the sections scroll (following the selection, or with PgUp/PgDn).
 */
export class Panel implements Component {
  /** Terminal rows; set by whoever shows the panel. */
  rows: () => number = () => 40
  private index = 0
  private scroll = 0
  private page = 10
  private readonly selectable: PanelRow[]
  private readonly border = new DynamicBorder()
  private readonly theme: Theme
  private readonly title: string
  private readonly subtitle: string | undefined
  private readonly sections: PanelSection[]
  private readonly keys: PanelKey[]
  private readonly done: (r: PanelResult) => void

  constructor(theme: Theme, title: string, subtitle: string | undefined, sections: PanelSection[], keys: PanelKey[], done: (r: PanelResult) => void, initialId?: string) {
    this.theme = theme
    this.title = title
    this.subtitle = subtitle
    this.sections = sections
    this.keys = keys
    this.done = done
    this.selectable = sections.flatMap(s => s.rows.filter(r => r.id))
    if (initialId) this.index = Math.max(0, this.selectable.findIndex(r => r.id === initialId))
  }

  invalidate(): void {
    this.border.invalidate()
  }

  /** All section lines, and where the selected row starts and ends. */
  private body(width: number): { lines: string[]; selFrom: number; selTo: number } {
    const t = this.theme
    const selected = this.selectable[this.index]
    const lines: string[] = []
    let selFrom = -1
    let selTo = -1
    for (const section of this.sections) {
      lines.push('')
      lines.push(clip('', `${t.bold(section.title)}${section.note ? `  ${t.fg('dim', section.note)}` : ''}`, width))
      if (section.rows.length === 0) {
        lines.push(...hang('', t.fg('dim', safe(section.empty ?? 'none')), width, 3))
        continue
      }
      const lw = section.leadWidth ?? 6
      for (const row of section.rows) {
        const isSel = row === selected
        if (isSel) selFrom = lines.length
        const marker = row.id && isSel ? t.fg('accent', '→ ') : '  '
        const text = isSel ? t.fg('accent', safe(row.text)) : paint(t, row.tone, safe(row.text))
        const lead = row.lead ? paint(t, row.tone, row.lead.padEnd(lw)) : ''
        lines.push(...hang(`${marker}${lead}`, text, width))
        if (row.detail) lines.push(...hang('', t.fg('dim', safe(row.detail)), width, row.lead ? 3 + lw : 5))
        if (isSel) selTo = lines.length - 1
      }
    }
    return { lines, selFrom, selTo }
  }

  private hintParts(scrollable: boolean): string[] {
    const selected = this.selectable[this.index]
    const parts: string[] = []
    if (this.selectable.length > 1) parts.push(rawKeyHint('↑↓', 'select'))
    else if (scrollable) parts.push(rawKeyHint('↑↓', 'scroll'))
    if (scrollable) parts.push(rawKeyHint('PgUp PgDn', 'page'))
    for (const k of this.keys) if (!k.needsSelection || selected) parts.push(rawKeyHint(k.key, k.label))
    parts.push(keyHint('tui.select.cancel', 'close'))
    return parts
  }

  render(width: number): string[] {
    const t = this.theme
    const w = Math.max(1, width)
    const top = this.border.render(w)
    const head = [clip('', `${t.fg('accent', t.bold(this.title))}${this.subtitle ? `  ${t.fg('muted', this.subtitle)}` : ''}`, w)]
    const { lines, selFrom, selTo } = this.body(w)
    const rows = Math.max(8, this.rows() || 40)
    // Leave room for Pi's footer below, as the approval dialog does.
    const budget = rows <= 20 ? rows - 4 : Math.min(rows - 5, Math.floor(rows * 0.85))
    const hintsFull = hintLines(this.hintParts(false), w)
    const fixed = top.length * 2 + head.length + 1 + hintsFull.length
    const room = Math.max(3, budget - fixed)
    const scrollable = lines.length > room
    const hints = scrollable ? hintLines(this.hintParts(true), w) : hintsFull
    const view = Math.max(3, room - (scrollable ? 1 + hints.length - hintsFull.length : 0))
    this.page = Math.max(1, view - 1)
    if (scrollable) {
      // Keep the selected row in view.
      if (selFrom >= 0 && selFrom < this.scroll) this.scroll = selFrom
      if (selTo >= 0 && selTo >= this.scroll + view) this.scroll = selTo - view + 1
      this.scroll = Math.min(Math.max(0, this.scroll), lines.length - view)
    } else this.scroll = 0
    const shown = lines.slice(this.scroll, this.scroll + view)
    const position = scrollable ? [clip('', t.fg('dim', `${this.scroll > 0 ? '↑ ' : '  '}lines ${this.scroll + 1}–${Math.min(lines.length, this.scroll + view)} of ${lines.length}${this.scroll + view < lines.length ? ' ↓' : ''}`), w)] : []
    return [...top, ...head, ...shown, ...position, '', ...hints, ...top]
  }

  handleInput(data: string): void {
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.cancel')) return this.done(undefined)
    const up = kb.matches(data, 'tui.select.up') || data === 'k'
    const down = kb.matches(data, 'tui.select.down') || data === 'j'
    if ((up || down) && this.selectable.length > 1) {
      this.index = (this.index + (up ? -1 : 1) + this.selectable.length) % this.selectable.length
      return
    }
    if (up || down) {
      this.scroll += up ? -1 : 1
      return
    }
    if (kb.matches(data, 'tui.select.pageUp') || data === '\x1b[5~') {
      this.scroll -= this.page
      return
    }
    if (kb.matches(data, 'tui.select.pageDown') || data === '\x1b[6~') {
      this.scroll += this.page
      return
    }
    const selected = this.selectable[this.index]
    const enter = kb.matches(data, 'tui.select.confirm') || data === '\n'
    for (const k of this.keys) {
      const hit = k.key === 'enter' ? enter : data === k.key || (k.key === 'del' && (data === '\x7f' || data === '\x1b[3~'))
      if (!hit) continue
      if (k.needsSelection && !selected) return
      return this.done({ key: k.key, id: selected?.id })
    }
    if (enter && this.keys.every(k => k.key !== 'enter')) this.done(undefined)
  }
}
