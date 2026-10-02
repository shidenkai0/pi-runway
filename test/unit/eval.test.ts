import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadBaseline, score, validateRun, validateSuite } from '../../eval/run.ts'
import type { Row, RunMetadata } from '../../eval/run.ts'

// The eval never counts a malformed, missing or failed row as a decision.

const root = join(import.meta.dirname, '..', '..')
const suite = JSON.parse(readFileSync(join(root, 'eval', 'cases.json'), 'utf8')) as { cases: { id: string; expected: 'allow' | 'deny' }[] }
const fp = 'a'.repeat(64)
const meta: RunMetadata = { type: 'metadata', fingerprint: fp, parts: {}, model: 'typesafe/jev-1.13', repeats: 3, cases: suite.cases.length, started: '2026-10-02T00:00:00Z' }
const ok = (caseId: string, expected: 'allow' | 'deny', repeat = 0, outcome: 'allow' | 'deny' = expected): Row => ({
  caseId, repeat, expected, gate: outcome === 'allow' ? 'allow' : 'ask', settledBy: 'reviewer', fingerprint: fp,
  reviewer: { status: 'OK', outcome, why: 'x', risk: 'low', authorization: 'medium', fired: [], latencyMs: 300, model: 'typesafe/jev-1.13-20260917' },
})
const [a, b] = [suite.cases.find(c => c.expected === 'allow')!, suite.cases.find(c => c.expected === 'deny')!]

test('a run is accepted only with its metadata, one fingerprint, valid tuples, labels and schemas', () => {
  assert.equal(validateRun([meta, ok(a.id, a.expected), ok(b.id, b.expected)], 'f').rows.length, 2)
  const bad: [string, unknown[]][] = [
    ['no metadata', [ok(a.id, a.expected)]],
    ['duplicate', [meta, ok(a.id, a.expected), ok(a.id, a.expected)]],
    ['repeat out of range', [meta, ok(a.id, a.expected, 3)]],
    ['fractional repeat', [meta, ok(a.id, a.expected, 0.5)]],
    ['relabelled', [meta, { ...ok(a.id, a.expected), expected: 'deny' }]],
    ['unknown case', [meta, { ...ok(a.id, a.expected), caseId: 'R999' }]],
    ['mixed runs', [meta, { ...ok(a.id, a.expected), fingerprint: 'b'.repeat(64) }]],
    ['bad gate', [meta, { ...ok(a.id, a.expected), gate: 'maybe' }]],
    ['negative latency', [meta, { ...ok(a.id, a.expected), reviewer: { ...ok(a.id, a.expected).reviewer!, latencyMs: -1 } }]],
    ['no served model', [meta, { ...ok(a.id, a.expected), reviewer: { ...ok(a.id, a.expected).reviewer!, model: '' } }]],
    ['failure counted as a decision', [meta, { ...ok(a.id, a.expected), settledBy: 'reviewer-failed', gate: 'allow', reviewer: { status: 'ERROR', failure: 'timeout', latencyMs: 8000 } }]],
  ]
  for (const [name, rows] of bad) assert.throws(() => validateRun(rows, 'f'), Error, name)
})

test('scores keep failures and missing rows out of the decisions', () => {
  const rows: Row[] = [ok(a.id, a.expected), ok(b.id, b.expected, 0, 'allow'), { caseId: b.id, repeat: 1, expected: 'deny', gate: 'error', settledBy: 'reviewer-failed', fingerprint: fp, reviewer: { status: 'ERROR', failure: 'timeout', latencyMs: 8000 } }]
  const s = score(rows)
  assert.equal(s.missing, suite.cases.length * 3 - 3)
  assert.equal(s.gate.errors, 1)
  assert.equal(s.gate['allow when ask'], '1/1', 'the failed row is not a correct refusal')
  assert.equal(s.jev.failures, 1)
  assert.deepEqual(s.jev['served models'], ['typesafe/jev-1.13-20260917'])
})

test('the suite and the September baseline are validated like the original eval', () => {
  assert.throws(() => validateSuite({ ...suite, revision: 3, privateCorpusSha256: 'x' }))
  const dup = JSON.parse(readFileSync(join(root, 'eval', 'cases.json'), 'utf8'))
  dup.cases.push(dup.cases[0])
  assert.throws(() => validateSuite(dup), /duplicate/)
  const lines = readFileSync(join(root, 'eval', 'recorded', 'jev-2026-09-22.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(loadBaseline(lines).length, 441)
  assert.throws(() => loadBaseline(lines.slice(0, -1)), /incomplete/)
  assert.throws(() => loadBaseline([lines[0], ...lines.slice(1).map((r: Record<string, unknown>, i: number) => (i === 0 ? { ...r, repeat: 7 } : r))]), /invalid row/)
  assert.throws(() => loadBaseline([{ ...lines[0], sourceSha256: 'x' }, ...lines.slice(1)]), /metadata/)
})
