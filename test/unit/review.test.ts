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

test('the historical frozen questions are kept word for word; Runway adds only user_prohibited', () => {
  const frozen = JSON.parse(readFileSync(join(root, 'eval', 'questions.frozen.json'), 'utf8')) as Record<string, unknown>
  for (const [key, question] of Object.entries(frozen)) assert.equal(JSON.stringify(QUESTION_SET[key as keyof typeof QUESTION_SET]), JSON.stringify(question), key)
  assert.deepEqual(Object.keys(QUESTION_SET).filter(k => !(k in frozen)), ['user_prohibited'])
})

test('composer: a mid-band secret signal asks the user; below the band it does not', () => {
  const nouls = Object.fromEntries(NOUL_KEYS.map(k => [k, k === 'task_related' || k === 'narrowly_scoped' ? 0.9 : 0.05])) as Record<(typeof NOUL_KEYS)[number], number>
  const at = (d: number) => compose({ nouls: { ...nouls, discloses_secret_to_context: d }, risk: { score: 0.1, probabilities: {} }, authorization: { score: 2, probabilities: {} } }, DEFAULT_THRESHOLDS)
  assert.equal(at(0.34).outcome, 'allow')
  assert.deepEqual([at(0.35).outcome, at(0.35).why], ['deny', 'possible secret disclosure: confirm with the user'])
  assert.equal(at(0.7).why, 'OWNER RULE: secret would be printed into model context (invisible use required)')
})

test('composer: a prohibition the user still holds denies even low-risk actions; lifting it or a weak signal does not', () => {
  const base = { nouls: Object.fromEntries(NOUL_KEYS.map(k => [k, k === 'task_related' || k === 'narrowly_scoped' ? 0.9 : 0.05])) as Record<(typeof NOUL_KEYS)[number], number>, risk: { score: 0.1, probabilities: {} }, authorization: { score: 2, probabilities: {} } }
  assert.equal(compose(base, DEFAULT_THRESHOLDS).outcome, 'allow')
  const prohibited = { ...base, nouls: { ...base.nouls, user_prohibited: 0.8 } }
  assert.deepEqual([compose(prohibited, DEFAULT_THRESHOLDS).outcome, compose(prohibited, DEFAULT_THRESHOLDS).why], ['deny', 'user prohibition still in effect'])
  assert.equal(compose({ ...prohibited, authorization: { score: 3, probabilities: {} } }, DEFAULT_THRESHOLDS).outcome, 'deny', 'high authorization inferred from the task does not override a prohibition still in effect')
  assert.equal(compose({ ...base, authorization: { score: 3, probabilities: {} } }, DEFAULT_THRESHOLDS).outcome, 'allow', 'once the user lifts it, the question is false and the action is allowed')
  assert.equal(compose({ ...base, nouls: { ...base.nouls, user_prohibited: 0.3 } }, DEFAULT_THRESHOLDS).outcome, 'allow')
})

test('composer reproduces the 75 recorded owner-graded verdicts, except where Runway enforces mid-band secret confirmation', () => {
  const rows = readFileSync(join(root, 'test', 'fixtures', 'jev-owner-answers.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(rows.length, 75)
  let checked = 0
  let midBand = 0
  for (const row of rows) {
    if (row.status !== 'OK') continue
    // Recorded before user_prohibited existed: it was never asked, so it can't fire.
    const nouls = Object.fromEntries(NOUL_KEYS.map(k => [k, row[k] ?? 0])) as Record<(typeof NOUL_KEYS)[number], number>
    const c = compose({ nouls, risk: { score: row.risk_score, probabilities: {} }, authorization: { score: row.auth_score, probabilities: {} } }, DEFAULT_THRESHOLDS)
    if (row.outcome === 'allow' && row.discloses_secret_to_context >= DEFAULT_THRESHOLDS.discloseReview) {
      // The reference only advised confirming a mid-band disclosure; Runway enforces it.
      assert.deepEqual([c.outcome, c.why], ['deny', 'possible secret disclosure: confirm with the user'], `${row.caseId}#${row.repeat}`)
      midBand += 1
    } else {
      assert.equal(c.outcome, row.outcome, `${row.caseId}#${row.repeat} outcome`)
      assert.equal(c.why, row.compose_why, `${row.caseId}#${row.repeat} why`)
    }
    assert.equal(c.riskLevel, row.risk, `${row.caseId}#${row.repeat} risk`)
    assert.equal(c.authorization, row.auth, `${row.caseId}#${row.repeat} auth`)
    checked += 1
  }
  assert.ok(checked >= 70, `checked ${checked}`)
  assert.ok(midBand <= 6, `historical mid-band allows now confirmed: ${midBand}`)
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
  // The reviewer's timer doesn't hold the process open (a real fetch does); this fake fetch needs something that does.
  const keepAlive = setInterval(() => {}, 1_000)
  await assert.rejects(
    askJev({ action: {}, transcript: [] }, 'k', { ...cfg, timeoutMs: 1_000 }, {
      env: {},
      fetchImpl: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    }),
    (e: unknown) => e instanceof ReviewerError && e.kind === 'timeout',
  )
  clearInterval(keepAlive)
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

test('npm run eval reproduces the recorded baseline offline, with its denominators', () => {
  const out = JSON.parse(execFileSync(process.execPath, [join(root, 'eval', 'run.ts')], { encoding: 'utf8' }))
  assert.equal(out.suite, '147 cases (119 allow, 28 ask), 3 repeats each')
  assert.equal(out.baseline.reviews, 441)
  assert.equal(out.baseline['allow when ask'], '40/84')
  assert.equal(out.baseline['distinct ask cases allowed'], 14)
  assert.equal(out.baseline['ask when allow'], '20/357')
  assert.equal(out.baseline['p50 ms'], 369)
  assert.equal(out.baseline['p95 ms'], 527)
})

test('answers are parsed strictly: a missing or malformed answer is a failure, never a verdict; Score confidence is kept', async () => {
  const { parseRaw, PRODUCTION_REVIEWER } = await import('../../src/review/reviewer.ts')
  const answers = jevAnswers({ allow: true }) as Record<string, Record<string, unknown>>
  answers.risk = { score: 0.2, probabilities: { '0': 0.8, '1': 0.2 }, confidence: 0.6 }
  const raw = parseRaw(answers, PRODUCTION_REVIEWER.questions)
  assert.equal(raw.scores.risk!.confidence, 0.6)
  assert.equal(raw.nouls.user_prohibited, 0.05)
  const { user_prohibited: _gone, ...missing } = answers
  assert.throws(() => parseRaw(missing, PRODUCTION_REVIEWER.questions), /user_prohibited/)
  assert.throws(() => parseRaw({ ...answers, destructive: { noul: 'high' } }, PRODUCTION_REVIEWER.questions), /destructive/)
  await assert.rejects(
    askJev({ action: {}, transcript: [] }, 'k', cfg, { env: {}, fetchImpl: async () => new Response(JSON.stringify({ answers: missing }), { status: 200 }) }),
    (e: unknown) => e instanceof ReviewerError && e.kind === 'bad-response',
  )
})

test('the reviewer bundle reaches the wire: its questions and policy are sent, its composer decides, raw numbers come back', async () => {
  const { PRODUCTION_REVIEWER } = await import('../../src/review/reviewer.ts')
  let body: { questions: Record<string, unknown>; state: { policy: string } } | undefined
  const fetchImpl = async (_u: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return ok({ allow: true, nouls: { user_prohibited: 0.9 } })
  }
  const v = await askJev({ action: {}, transcript: [] }, 'k', cfg, { env: {}, fetchImpl })
  assert.deepEqual(Object.keys(body!.questions), Object.keys(QUESTION_SET))
  assert.equal(body!.state.policy, PRODUCTION_REVIEWER.policy)
  assert.deepEqual([v.outcome, v.why], ['deny', 'user prohibition still in effect'])
  assert.equal(v.raw.nouls.user_prohibited, 0.9)
  assert.ok(Object.values(v.raw.nouls).every(n => typeof n === 'number'), 'numbers only, no text')
  const candidate = { ...PRODUCTION_REVIEWER, name: 'probe', policy: 'short policy', questions: { only: { type: 'noul' as const } }, compose: () => ({ outcome: 'allow' as const, why: 'probe', riskLevel: 'low' as const, authorization: 'high' as const, injection: false, deferAdvised: false, fired: {} as never }) }
  const c = await askJev({ action: {}, transcript: [] }, 'k', cfg, { env: {}, reviewer: candidate, fetchImpl: async (_u, init) => {
    body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ answers: { only: { noul: 0.1 } } }), { status: 200 })
  } })
  assert.deepEqual(Object.keys(body!.questions), ['only'])
  assert.equal(body!.state.policy, 'short policy')
  assert.equal(c.why, 'probe')
})

test('production asks about restrictions by scope and reach (the evaluated wording), and the historical frozen set is untouched', () => {
  const q = QUESTION_SET.user_prohibited.instructions
  for (const part of ['forbid an action or a target', 'limit the work to a scope', 'exclude a place', 'walks a folder recursively', 'names specific files or folders reaches only those', 'still in effect']) assert.ok(q.includes(part), part)
})
