// Reproduces every reviewer figure the README cites, offline, from the
// recorded September 22, 2026 evaluation of Jev carried over from
// pi-auto-review-jev (eval/historical/). These are historical measurements of
// Jev on permission prompts from an earlier setup — not measurements of
// Runway's escalations, which have not been evaluated yet.
//
//   node eval/summary.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const here = join(import.meta.dirname, 'historical')
const suite = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')) as { cases: { id: string; expected: 'allow' | 'deny' }[] }
const label = new Map(suite.cases.map(c => [c.id, c.expected]))
const rows = readFileSync(join(here, 'recorded-2026-09-22.jsonl'), 'utf8').trim().split('\n').slice(1).map(l => JSON.parse(l) as {
  dataset: string; caseId: string; status: string; outcome?: 'allow' | 'deny'; latency_ms: number; cost?: number
})
const jev = rows.filter(r => r.dataset.startsWith('jev') && label.has(r.caseId))
const valid = jev.filter(r => r.status === 'OK')
const shouldAsk = valid.filter(r => label.get(r.caseId) === 'deny')
const shouldAllow = valid.filter(r => label.get(r.caseId) === 'allow')
const wrongAllows = shouldAsk.filter(r => r.outcome === 'allow')
const falseAsks = shouldAllow.filter(r => r.outcome === 'deny')
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * p) - 1)]
const lat = jev.map(r => r.latency_ms)
const cost = valid.map(r => r.cost).filter((c): c is number => typeof c === 'number')
const casesAsk = suite.cases.filter(c => c.expected === 'deny').length

const summary = {
  source: 'eval/historical: 147 labelled cases (119 allow, 28 ask), each reviewed 3 times; Jev served as typesafe/jev-1.13-20260917; recorded 2026-09-22',
  reviews: jev.length,
  validReviews: valid.length,
  shouldAskCases: casesAsk,
  shouldAskAttempts: shouldAsk.length,
  approvedWhenShouldAsk: wrongAllows.length,
  distinctCasesApprovedAtLeastOnce: new Set(wrongAllows.map(r => r.caseId)).size,
  shouldAllowAttempts: shouldAllow.length,
  askedWhenShouldAllow: falseAsks.length,
  latencyMs: { median: pct(lat, 0.5), p95: pct(lat, 0.95), max: Math.max(...lat) },
  costUsd: { median: pct(cost, 0.5), mean: Number((cost.reduce((a, b) => a + b, 0) / cost.length).toFixed(6)) },
}
console.log(JSON.stringify(summary, null, 2))
