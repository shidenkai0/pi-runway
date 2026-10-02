import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initTheme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'
import { theme } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js'
import { ApprovalDialog } from '../../src/ui/approval.ts'
import type { ApprovalChoice, ApprovalRequest } from '../../src/ui/approval.ts'
import { safe } from '../../src/ui/text.ts'

// The approval dialog rendered with Pi's real theme and components.

initTheme('dark', false)
const plain = (lines: string[]) => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''))

const longCommand = `$ node -e "${'console.log(123);'.repeat(80)}"`
const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  tool: 'bash', who: 'Subagent "release-check"', verb: 'run a command',
  action: [longCommand],
  why: 'Jev said no: this could overwrite production state without your explicit approval.', whyTone: 'warning',
  runs: 'in the sandbox, plus write access to ../shared for this command', runsTone: 'warning',
  sessionOpLabel: 'this exact command', sessionToolLabel: 'Allow every bash call this session', saveScopes: [], focusDeny: true,
  ...over,
})

test('the dialog fits the terminal: decisions stay visible however long the action is', () => {
  for (const width of [100, 80, 40, 20]) for (const rows of [40, 24, 18, 12]) {
    const lines = new ApprovalDialog(request(), theme, () => {}, () => rows).render(width)
    assert.ok(lines.length < rows, `${width}x${rows}: ${lines.length} rows`)
    assert.ok(lines.every(l => visibleWidth(l) <= width), `${width}x${rows}: no line wider than the terminal`)
    const text = plain(lines).join('\n')
    for (const choice of ['Allow once', 'Deny']) assert.ok(text.includes(choice), `${width}x${rows}: ${choice} visible`)
    assert.match(text, /… \d+ more line/, `${width}x${rows}: says the action continues`)
    assert.match(text, /\bv (view|to see)/, `${width}x${rows}: says how to see it`)
  }
})

test('v opens the whole action, scrollable to the last character; Escape returns, then denies', () => {
  const choices: ApprovalChoice[] = []
  const d = new ApprovalDialog(request(), theme, c => choices.push(c), () => 24)
  d.handleInput('v')
  const first = plain(d.render(40)).join('\n')
  assert.match(first, /The full request\s+lines 1–/)
  d.handleInput('G')
  const last = plain(d.render(40)).join('\n')
  assert.match(last, /console\.log\(123\);"/, 'the end of the command is reachable')
  assert.match(last, /Runs\s+in the sandbox/)
  d.handleInput('\x1b')
  assert.match(plain(d.render(40)).join('\n'), /Allow once/)
  assert.deepEqual(choices, [], 'leaving the full view decides nothing')
  d.handleInput('\x1b')
  assert.deepEqual(choices, [{ kind: 'deny' }])
})

test('terminal control characters in an action are shown, never sent to the terminal', () => {
  const lines = new ApprovalDialog(request({ action: ['$ printf "\x1b]0;owned\x07\x1b[2J\rhidden‮evil"'] }), theme, () => {}, () => 40).render(80)
  const text = lines.join('\n')
  assert.doesNotMatch(text, /\x1b\]0;|\x07|\x1b\[2J|\r|‮/)
  assert.match(plain(lines).join('\n'), /\\x1b\]0;owned\\x07\\x1b\[2J\\x0dhidden\\u\{202e\}evil/)
  assert.equal(safe('a\tb'), 'a  b')
})
