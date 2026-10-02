// How much Runway interrupted, per session: counts only, in memory, gone when
// Pi exits. No commands, arguments or conversation are kept, and nothing is
// sent anywhere. /runway shows them for the current session and its
// subagents, so a trial can report all approval prompts (for any tool or
// connection) per 100 bash command requests, with both numbers in plain
// sight. It is a normalized interruption rate, not a false-alarm rate;
// refusals because nobody could be asked are counted separately.

export interface Tally {
  /** Tool calls the gate decided (connections out of the sandbox are not tool calls). */
  toolCalls: number
  /** Of those, bash command requests (decided, whether or not they then ran). */
  commands: number
  /** Approval dialogs actually shown to a person, for any tool call or connection. */
  prompts: number
  /** Calls refused because a person was needed and nobody could be asked (headless, no parent screen). */
  unattended: number
  /** Calls refused by your rules, the reviewer or you. */
  refused: number
  jev: { allowed: number; refused: number; failed: number; latencies: number[] }
  /** Allowed calls that run outside the sandbox or inside Pi, by who allowed them (routine file-tool defaults excluded). */
  outside: { jev: number; you: number; rulesOrGrants: number }
}

const MAX_LATENCIES = 1000

export function emptyTally(): Tally {
  return { toolCalls: 0, commands: 0, prompts: 0, unattended: 0, refused: 0, jev: { allowed: 0, refused: 0, failed: 0, latencies: [] }, outside: { jev: 0, you: 0, rulesOrGrants: 0 } }
}

export class TrialCounters {
  private readonly bySession = new Map<string, Tally>()

  for(sessionId: string): Tally {
    let t = this.bySession.get(sessionId)
    if (!t) {
      t = emptyTally()
      this.bySession.set(sessionId, t)
    }
    return t
  }

  jevLatency(sessionId: string, ms: number): void {
    const l = this.for(sessionId).jev.latencies
    if (l.length < MAX_LATENCIES) l.push(ms)
  }

  /** The sum over these sessions (a session and its subagents). */
  sum(sessionIds: Iterable<string>): Tally {
    const total = emptyTally()
    for (const id of sessionIds) {
      const t = this.bySession.get(id)
      if (!t) continue
      total.toolCalls += t.toolCalls
      total.commands += t.commands
      total.prompts += t.prompts
      total.unattended += t.unattended
      total.refused += t.refused
      total.jev.allowed += t.jev.allowed
      total.jev.refused += t.jev.refused
      total.jev.failed += t.jev.failed
      total.jev.latencies.push(...t.jev.latencies)
      total.outside.jev += t.outside.jev
      total.outside.you += t.outside.you
      total.outside.rulesOrGrants += t.outside.rulesOrGrants
    }
    return total
  }

  sessions(): string[] {
    return [...this.bySession.keys()]
  }
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : undefined)

/** Short lines for the /runway panel. */
export function describeTally(t: Tally): string[] {
  // All approval prompts (any tool, any connection), normalized by bash command requests; not a false-alarm rate.
  const rate = t.commands ? `${((100 * t.prompts) / t.commands).toFixed(t.prompts && t.commands < 100 ? 1 : 0)} per 100 command requests` : 'no command requests yet'
  const reviewed = t.jev.allowed + t.jev.refused + t.jev.failed
  const lines = [
    `${t.toolCalls} tool call${t.toolCalls === 1 ? '' : 's'}, ${t.commands} command request${t.commands === 1 ? '' : 's'} · ${t.refused} refused`,
    `Approval prompts: ${t.prompts} (${rate}; ${t.prompts} prompt${t.prompts === 1 ? '' : 's'} / ${t.commands} command request${t.commands === 1 ? '' : 's'})`,
    reviewed ? `Jev reviewed ${reviewed}: ${t.jev.allowed} allowed, ${t.jev.refused} said no, ${t.jev.failed} failed · median ${median(t.jev.latencies) ?? '–'} ms` : 'Jev reviewed nothing yet',
    `Allowed outside the sandbox or inside Pi: ${t.outside.jev} by Jev, ${t.outside.you} by you, ${t.outside.rulesOrGrants} by your rules or approvals`,
  ]
  if (t.unattended) lines.push(`Refused with nobody to ask: ${t.unattended}`)
  return lines
}
