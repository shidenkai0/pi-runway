import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { compose, DEFAULT_THRESHOLDS } from '../../src/review/compose.ts'
import { NOUL_KEYS, QUESTION_SET } from '../../src/review/questions.ts'
import { askJev, buildState, resolveReviewerKey, ReviewerError } from '../../src/review/jev.ts'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import { jevAnswers } from '../support/harness.ts'

const root = join(import.meta.dirname, '..', '..')

test('question wording is byte-identical to the evaluated set', () => {
  const frozen = JSON.parse(readFileSync(join(root, 'eval', 'questions.frozen.json'), 'utf8'))
  assert.equal(JSON.stringify(QUESTION_SET), JSON.stringify(frozen))
})

test('composer reproduces all 75 recorded owner-graded verdicts', () => {
  const rows = readFileSync(join(root, 'eval', 'jev-owner-recorded.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(rows.length, 75)
  let checked = 0
  for (const row of rows) {
    if (row.status !== 'OK') continue
    const nouls = Object.fromEntries(NOUL_KEYS.map(k => [k, row[k]])) as Record<(typeof NOUL_KEYS)[number], number>
    const c = compose({ nouls, risk: { score: row.risk_score, probabilities: {} }, authorization: { score: row.auth_score, probabilities: {} } }, DEFAULT_THRESHOLDS)
    assert.equal(c.outcome, row.outcome, `${row.caseId}#${row.repeat} outcome`)
    assert.equal(c.why, row.compose_why, `${row.caseId}#${row.repeat} why`)
    assert.equal(c.riskLevel, row.risk, `${row.caseId}#${row.repeat} risk`)
    assert.equal(c.authorization, row.auth, `${row.caseId}#${row.repeat} auth`)
    checked += 1
  }
  assert.ok(checked >= 70, `checked ${checked}`)
})

test('outbound state redacts secret-shaped values in the action', () => {
  const state = buildState({ action: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" https://x.test OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx' }, transcript: [] })
  const text = JSON.stringify(state)
  assert.ok(!text.includes('abcdefghijklmnopqrstuvwxyz0123'))
  assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwx'))
  assert.match(text, /REDACTED/)
})

const cfg = { ...DEFAULT_CONFIG.reviewer, timeoutMs: 1_000, maxAttempts: 2 }
const ok = (spec = {}) => new Response(JSON.stringify({ model: 'jev-x', answers: jevAnswers(spec) }), { status: 200 })

test('allow and deny verdicts come from the composer', async () => {
  const allow = await askJev({ action: {}, transcript: [] }, 'k', cfg, { fetchImpl: async () => ok({ allow: true }), env: {} })
  assert.equal(allow.outcome, 'allow')
  const deny = await askJev({ action: {}, transcript: [] }, 'k', cfg, { fetchImpl: async () => ok({ allow: false }), env: {} })
  assert.equal(deny.outcome, 'deny')
  assert.match(deny.why, /sensitive_egress/)
})

test('retries a 503 once, then succeeds', async () => {
  let calls = 0
  const v = await askJev({ action: {}, transcript: [] }, 'k', cfg, {
    env: {},
    fetchImpl: async () => (++calls === 1 ? new Response('{}', { status: 503 }) : ok()),
  })
  assert.equal(calls, 2)
  assert.equal(v.outcome, 'allow')
})

test('timeouts, HTTP errors and malformed answers are errors, never verdicts', async () => {
  await assert.rejects(
    askJev({ action: {}, transcript: [] }, 'k', { ...cfg, timeoutMs: 1_000 }, {
      env: {},
      fetchImpl: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    }),
    (e: unknown) => e instanceof ReviewerError && e.kind === 'timeout',
  )
  await assert.rejects(askJev({ action: {}, transcript: [] }, 'k', cfg, { env: {}, fetchImpl: async () => new Response('{}', { status: 401 }) }), (e: unknown) => e instanceof ReviewerError && e.kind === 'http')
  await assert.rejects(askJev({ action: {}, transcript: [] }, 'k', cfg, { env: {}, fetchImpl: async () => new Response('{"answers":{}}', { status: 200 }) }), (e: unknown) => e instanceof ReviewerError && e.kind === 'bad-response')
  await assert.rejects(askJev({ action: {}, transcript: [] }, 'k', cfg, { env: {}, fetchImpl: async () => new Response('not json', { status: 200 }) }), (e: unknown) => e instanceof ReviewerError && e.kind === 'bad-response')
})

test('reviewer key: env first, then Pi credentials, then nothing', async () => {
  assert.equal(await resolveReviewerKey('openrouter', {}, { OPENROUTER_API_KEY: 'env-key' }, '/nonexistent'), 'env-key')
  assert.equal(await resolveReviewerKey('openrouter', { getApiKeyForProvider: async p => (p === 'openrouter' ? 'pi-key' : undefined) }, {}, '/nonexistent'), 'pi-key')
  assert.equal(await resolveReviewerKey('openrouter', { getApiKeyForProvider: async () => { throw new Error('x') } }, {}, '/nonexistent'), undefined)
  assert.equal(await resolveReviewerKey('typesafe-direct', {}, { TYPESAFE_API_KEY: 't' }, '/nonexistent'), 't')
})

test('historical figures quoted in the README reproduce from the recorded data', () => {
  const out = JSON.parse(execFileSync(process.execPath, [join(root, 'eval', 'summary.ts')], { encoding: 'utf8' }))
  assert.equal(out.shouldAskAttempts, 84)
  assert.equal(out.approvedWhenShouldAsk, 40)
  assert.equal(out.distinctCasesApprovedAtLeastOnce, 14)
  assert.equal(out.shouldAskCases, 28)
  assert.equal(out.askedWhenShouldAllow, 20)
  assert.equal(out.shouldAllowAttempts, 357)
  assert.equal(out.latencyMs.median, 369)
  assert.equal(out.latencyMs.p95, 527)
})
