import { compose, DEFAULT_THRESHOLDS } from './compose.ts'
import type { Composition } from './compose.ts'
import { buildSystemPrompt } from './prompt.ts'
import { NOUL_KEYS, QUESTION_SET, QuestionParseError } from './questions.ts'
import type { NoulKey, QuestionAnswers, ScoreAnswer } from './questions.ts'

// What Jev is asked, what it reads, and how its answers become a decision:
// one bundle, so the evaluation can compare a candidate with production on
// the same cases without touching production's definition.

/** Jev's answers as numbers only: Noul probabilities, Score distributions and confidence. */
export interface RawAnswers {
  nouls: Record<string, number>
  scores: Record<string, ScoreAnswer>
}

export interface Reviewer {
  /** Recorded with eval runs. */
  name: string
  questions: Record<string, { type: 'noul' | 'score' }>
  /** The policy text the state carries as `policy`. */
  policy: string
  compose(raw: RawAnswers): Composition
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Every question in the set must come back with the right shape; anything else is a parse failure (never a verdict). */
export function parseRaw(answers: unknown, questions: Reviewer['questions']): RawAnswers {
  if (!isRecord(answers)) throw new QuestionParseError('answers: expected object')
  const raw: RawAnswers = { nouls: {}, scores: {} }
  for (const [key, q] of Object.entries(questions)) {
    const a = answers[key]
    if (q.type === 'noul') {
      if (!isRecord(a) || !finite(a.noul)) throw new QuestionParseError(`answers.${key}: expected {noul: number}`)
      raw.nouls[key] = a.noul
      continue
    }
    if (!isRecord(a) || !finite(a.score) || !isRecord(a.probabilities)) throw new QuestionParseError(`answers.${key}: expected {score: number, probabilities: object}`)
    const probabilities: Record<string, number> = {}
    for (const [level, p] of Object.entries(a.probabilities)) {
      if (!finite(p)) throw new QuestionParseError(`answers.${key}.probabilities.${level}: expected number`)
      probabilities[level] = p
    }
    raw.scores[key] = { score: a.score, probabilities, ...(finite(a.confidence) ? { confidence: a.confidence } : {}) }
  }
  return raw
}

/** The production composer's input from raw answers. */
export function toQuestionAnswers(raw: RawAnswers): QuestionAnswers {
  return {
    nouls: Object.fromEntries(NOUL_KEYS.map(k => [k, raw.nouls[k]!])) as Record<NoulKey, number>,
    risk: raw.scores.risk!,
    authorization: raw.scores.authorization!,
  }
}

export const PRODUCTION_REVIEWER: Reviewer = {
  name: 'runway-production',
  questions: QUESTION_SET,
  policy: buildSystemPrompt(),
  compose: raw => compose(toQuestionAnswers(raw), DEFAULT_THRESHOLDS),
}
