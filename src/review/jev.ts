import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunwayConfig, ReviewerRoute } from '../config.ts'
import { compose, DEFAULT_THRESHOLDS } from './compose.ts'
import type { Composition } from './compose.ts'
import { buildSystemPrompt } from './prompt.ts'
import { parseQuestions, QUESTION_SET } from './questions.ts'
import { redactActionValue } from './redact.ts'

// Jev (TypeSafe's System One safety model). One structured request per
// escalation: fixed safety questions come back as probabilities, and the
// verdict is composed in code (compose.ts), never by the model.

const ROUTE_URLS: Record<ReviewerRoute, string> = {
  openrouter: 'https://openrouter.ai/api/alpha/decisions',
  'typesafe-direct': 'https://api.typesafe.ai/v1/systemone',
}
const ROUTE_ENV: Record<ReviewerRoute, string> = { openrouter: 'OPENROUTER_API_KEY', 'typesafe-direct': 'TYPESAFE_API_KEY' }
const ROUTE_PROVIDER: Record<ReviewerRoute, string> = { openrouter: 'openrouter', 'typesafe-direct': 'typesafe' }
const RETRYABLE = new Set([429, 500, 502, 503, 504])
const RETRY_DELAY_MS = 250

export interface KeySource {
  /** Pi's own credential lookup (auth.json, !commands, env); may be absent in tests. */
  getApiKeyForProvider?: (provider: string) => Promise<string | undefined>
}

export async function resolveReviewerKey(
  route: ReviewerRoute,
  source: KeySource,
  env: NodeJS.ProcessEnv,
  agentDir: string,
): Promise<string | undefined> {
  const fromEnv = env[ROUTE_ENV[route]]
  if (fromEnv) return fromEnv
  try {
    const fromPi = await source.getApiKeyForProvider?.(ROUTE_PROVIDER[route])
    if (fromPi) return fromPi
  } catch {
    // fall through to the file
  }
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8')) as Record<string, unknown>
    const entry = parsed[ROUTE_PROVIDER[route]]
    if (typeof entry === 'string' && entry) return entry
    if (entry && typeof entry === 'object') {
      const key = (entry as Record<string, unknown>).key
      if (typeof key === 'string' && key && !key.startsWith('!')) return key
    }
  } catch {
    // no auth.json
  }
  return undefined
}

export interface JevVerdict {
  outcome: 'allow' | 'deny'
  why: string
  risk: string
  authorization: string
  fired: string[]
  latencyMs: number
  model: string
}

export class ReviewerError extends Error {
  readonly kind: 'no-key' | 'http' | 'timeout' | 'bad-response' | 'cancelled'
  constructor(kind: ReviewerError['kind'], message: string) {
    super(message)
    this.name = 'ReviewerError'
    this.kind = kind
  }
}

export interface JevRequest {
  /** What the agent wants to do, as the reviewer sees it. Secret-shaped values are redacted here. */
  action: Record<string, unknown>
  /** Bounded, redacted transcript excerpt (transcript.ts). */
  transcript: object[]
}

export interface JevDeps {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

export function buildState(request: JevRequest): Record<string, unknown> {
  return {
    policy: buildSystemPrompt(),
    transcript: request.transcript,
    action: Object.fromEntries(Object.entries(request.action).map(([k, v]) => [k, redactActionValue(v)])),
    uid: randomBytes(8).toString('hex'),
  }
}

export async function askJev(
  request: JevRequest,
  apiKey: string,
  cfg: RunwayConfig['reviewer'],
  deps: JevDeps = {},
): Promise<JevVerdict> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const env = deps.env ?? process.env
  // Test hook: point the reviewer at a local fake. Never set in normal use.
  const url = env.PI_RUNWAY_REVIEWER_URL || ROUTE_URLS[cfg.route]
  const model = cfg.route === 'openrouter' ? cfg.model : cfg.modelDirect
  const body = JSON.stringify({ model, state: buildState(request), questions: QUESTION_SET })
  const timeout = AbortSignal.timeout(cfg.timeoutMs)
  const signal = deps.signal ? AbortSignal.any([timeout, deps.signal]) : timeout
  const started = Date.now()
  const fail = (error: unknown): never => {
    if (timeout.aborted) throw new ReviewerError('timeout', `Jev did not answer within ${cfg.timeoutMs} ms`)
    if (deps.signal?.aborted) throw new ReviewerError('cancelled', 'review cancelled')
    throw new ReviewerError('http', `Jev request failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  for (let attempt = 1; ; attempt += 1) {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal,
      })
    } catch (error) {
      if (attempt < cfg.maxAttempts && !signal.aborted) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
        continue
      }
      return fail(error)
    }
    if (!response.ok) {
      if (RETRYABLE.has(response.status) && attempt < cfg.maxAttempts) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
        continue
      }
      throw new ReviewerError('http', `Jev returned HTTP ${response.status}`)
    }
    let json: Record<string, unknown>
    try {
      json = (await response.json()) as Record<string, unknown>
    } catch (error) {
      if (signal.aborted) return fail(error)
      throw new ReviewerError('bad-response', 'Jev returned a body that is not JSON')
    }
    let composition: Composition
    try {
      composition = compose(parseQuestions(json?.answers), DEFAULT_THRESHOLDS)
    } catch (error) {
      throw new ReviewerError('bad-response', error instanceof Error ? error.message : 'unexpected Jev answer shape')
    }
    return {
      outcome: composition.outcome,
      why: composition.why,
      risk: composition.riskLevel,
      authorization: composition.authorization,
      fired: Object.entries(composition.fired).filter(([, v]) => v).map(([k]) => k),
      latencyMs: Date.now() - started,
      model: typeof json.model === 'string' ? json.model : model,
    }
  }
}
