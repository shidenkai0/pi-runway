import type { Component } from '@earendil-works/pi-tui'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

// Small layout helpers so wrapped text lines up under itself (hanging indent)
// and long values are clipped instead of sprawling across the dialog.

/** A component drawn by a function of the available width. */
export class Lines implements Component {
  private readonly draw: (width: number) => string[]
  constructor(draw: (width: number) => string[]) {
    this.draw = draw
  }
  render(width: number): string[] {
    return this.draw(width)
  }
  invalidate(): void {}
}

/**
 * `prefix` then `text`, wrapped so continuation lines start under the text.
 * `margin` spaces precede every line.
 */
export function hang(prefix: string, text: string, width: number, margin = 1): string[] {
  const lead = margin + visibleWidth(prefix)
  const room = Math.max(8, width - lead - 1)
  const wrapped = text.split('\n').flatMap(part => wrapTextWithAnsi(part, room))
  if (wrapped.length === 0) wrapped.push('')
  return wrapped.map((line, i) => `${' '.repeat(margin)}${i === 0 ? prefix : ' '.repeat(visibleWidth(prefix))}${line}`)
}

/** One line, clipped with an ellipsis to fit. */
export function clip(prefix: string, text: string, width: number, margin = 1): string {
  return truncateToWidth(`${' '.repeat(margin)}${prefix}${text}`, Math.max(8, width - 1), '…')
}

/**
 * Make untrusted text safe to draw: control characters (escape sequences,
 * carriage returns, bells…) and bidirectional overrides are shown as visible
 * escapes instead of acting on the terminal. Tabs become two spaces; newlines
 * are kept for the caller to split.
 */
export function safe(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, c => `\\u{${c.charCodeAt(0).toString(16)}}`)
}

/** At most `max` lines; the last one says it continues (with room for one line, that line is kept instead). */
export function capLines(lines: string[], max: number, more = '…'): string[] {
  if (lines.length <= max) return lines
  if (max <= 1) return lines.slice(0, 1)
  return [...lines.slice(0, max - 1), more]
}

/** Key hints packed into lines, breaking only between hints. */
export function hintLines(parts: string[], width: number, margin = 1): string[] {
  const lines: string[] = []
  let line = ''
  for (const part of parts) {
    const next = line ? `${line}  ${part}` : part
    if (line && margin + visibleWidth(next) > width - 1) {
      lines.push(line)
      line = part
    } else line = next
  }
  if (line) lines.push(line)
  return lines.map(l => truncateToWidth(`${' '.repeat(margin)}${l}`, Math.max(8, width - 1), '…'))
}
