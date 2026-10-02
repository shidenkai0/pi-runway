import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fingerprintParts, loadBaseline, preparePublic, score, summary, validateRun, validateSuite } from '../../eval/run.ts'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import type { RunwayConfig } from '../../src/config.ts'
import type { Row, RunMetadata } from '../../eval/run.ts'

// The eval never counts a malformed, missing or failed row as a decision.

const root = join(import.meta.dirname, '..', '..')
const suite = JSON.parse(readFileSync(join(root, 'eval', 'cases.json'), 'utf8')) as { cases: { id: string; expected: 'allow' | 'deny' }[]; publicCases: { id: string; expected: 'allow' | 'deny'; pair: string; role: string; call: { tool: string }; transcript: { source: string }[] }[] }
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

test('older public runs keep their original planned count when new cases are appended', () => {
  const original = JSON.parse(readFileSync(join(root, 'eval', 'recorded', 'runway-2026-10-02T10-55-57-082Z.jsonl'), 'utf8').split('\n')[0]!)
  const lines = readFileSync(join(root, 'eval', 'recorded', 'runway-2026-10-02T10-55-57-082Z.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const run = validateRun(lines, 'older-public')
  assert.equal(original.cases, 24)
  assert.equal(score(run.rows, 'public', run.meta.cases).missing, 0)
  assert.throws(() => validateRun([{ ...original, cases: 1 }, ...run.rows], 'too-many'), /planned case count/)
  assert.throws(() => validateRun([{ ...original, cases: 0 }, ...run.rows], 'zero'), /planned case count/)
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

test('public cases live in the same manifest, apart from the 147 historical ones, which are unchanged', () => {
  assert.equal(suite.cases.length, 147)
  assert.ok(suite.publicCases.length >= 12)
  for (const pair of new Set(suite.publicCases.map(c => c.pair))) {
    const members = suite.publicCases.filter(c => c.pair === pair)
    assert.deepEqual([...new Set(members.map(c => c.expected))].sort(), ['allow', 'deny'], `${pair} pairs a should-ask with a should-allow`)
  }
  assert.ok(suite.publicCases.every(c => c.transcript.some(e => e.source === 'user')), 'every case has user evidence')
  // The historical labels hash still equals the one the recorded run was made with: only code changed since.
  const s = summary()
  assert.ok(!(s.runway!['changed since this run'] as string[]).includes('labels'))
  assert.equal(s.baseline['allow when ask'], '40/84')
  const historical = fingerprintParts({ ...DEFAULT_CONFIG, mode: 'auto', onDeny: 'block' } as RunwayConfig, {}, 'historical')
  const pub = fingerprintParts({ ...DEFAULT_CONFIG, mode: 'auto', onDeny: 'block' } as RunwayConfig, {}, 'public')
  assert.notEqual(historical.labels, pub.labels)
  assert.equal(historical.code, pub.code)
})

test('a public case becomes the call Runway would gate, with its own working folder and attributed conversation', () => {
  const c = (suite.publicCases as never[]).find((x: { id: string }) => x.id === 'P07')!
  const p = preparePublic(c)
  assert.equal(p.op.kind, 'shell')
  assert.equal(p.cwd, '/work/acme-wt-login')
  assert.equal(p.recordedRequest, undefined)
  assert.deepEqual(p.notRecorded, [])
  assert.deepEqual((p.transcript as { source: string; index: number }[]).map(e => [e.index, e.source]), [[0, 'user'], [1, 'tool']])
})

test('public runs are validated and scored against public labels only; missing and failed rows stay out', () => {
  const pubMeta: RunMetadata = { ...meta, selection: 'public', cases: suite.publicCases.length }
  const [pa, pd] = [suite.publicCases.find(c => c.expected === 'allow')!, suite.publicCases.find(c => c.expected === 'deny')!]
  const run = validateRun([pubMeta, ok(pa.id, 'allow'), ok(pd.id, 'deny', 0, 'allow'), { caseId: pd.id, repeat: 1, expected: 'deny', gate: 'error', settledBy: 'reviewer-failed', fingerprint: fp, reviewer: { status: 'ERROR', failure: 'timeout', latencyMs: 8000 } }], 'p')
  const s = score(run.rows, 'public')
  assert.equal(s.planned, suite.publicCases.length * 3)
  assert.equal(s.missing, suite.publicCases.length * 3 - 3)
  assert.equal(s.gate['allow when ask'], '1/1')
  assert.equal(s.gate.errors, 1)
  assert.throws(() => validateRun([pubMeta, ok(a.id, a.expected)], 'p'), /invalid row/, 'a historical id in a public run')
  assert.throws(() => validateRun([meta, ok(pa.id, 'allow')], 'h'), /invalid row/, 'a public id in a historical run')
})

test('raw reviewer answers in a row must be numbers; candidate reviewer runs are listed apart from production', () => {
  const pubMeta: RunMetadata = { ...meta, selection: 'public', cases: suite.publicCases.length }
  const pa = suite.publicCases.find(c => c.expected === 'allow')!
  const withRaw = (raw: unknown) => ({ ...ok(pa.id, 'allow'), reviewer: { ...ok(pa.id, 'allow').reviewer!, raw } })
  assert.equal(validateRun([pubMeta, withRaw({ nouls: { a: 0.1 }, scores: { risk: { score: 0.2, probabilities: { '0': 0.8 }, confidence: 0.7 } } })], 'p').rows.length, 1)
  assert.throws(() => validateRun([pubMeta, withRaw({ nouls: { a: 'text' }, scores: {} })], 'p'), /numbers/)
  const s = summary()
  const latest = s.public.latest as { source: string }
  const candidates = s.public['candidate reviewers'] as { source: string; variant: string }[]
  assert.ok(candidates.length >= 1 && candidates.every(c => c.variant))
  assert.ok(!candidates.some(c => c.source === latest.source), 'a candidate run is never reported as the production result')
})
