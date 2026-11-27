/** Projects runs of failed context compactions from session event streams. */
import type { RetryHealthEvent } from './retry-health.ts'

export interface CompactionFailureStatus { sessionId: string; failures: number; cause: 'context overflow' | 'rate limit or credits' | 'other'; since: string; lastAt: string }
/** How many compactions in a row must fail before a Session is reported: a single failure often recovers on the next one. */
export const COMPACTION_FAILURES = 3

const causeOf = (error: string): CompactionFailureStatus['cause'] => /context (?:overflow|length)|too long|maximum context/i.test(error) ? 'context overflow'
  : /\b429\b|credits|usage limit|rate.?limit|quota/i.test(error) ? 'rate limit or credits' : 'other'

/**
 * Tracks, per Session, how many context compactions in a row have failed. A Session whose compactions keep failing keeps
 * growing its context; once it no longer fits the model, compaction cannot succeed again and every step waits on a failing
 * compaction first, which a restart does not change. A successful compaction clears the run; idling does not.
 */
export class CompactionHealth {
  private readonly sessions = new Map<string, { seq: number; status?: CompactionFailureStatus }>()

  restore(sessionId: string, events: readonly RetryHealthEvent[]): void {
    this.sessions.delete(sessionId)
    for (const event of events) this.observe(sessionId, event)
  }
  forget(sessionId: string): void { this.sessions.delete(sessionId) }

  observe(sessionId: string, event: RetryHealthEvent): void {
    if (event.type !== 'compaction/end' || !Number.isFinite(event.time)) return
    const state = this.sessions.get(sessionId) ?? { seq: -1 }
    if (event.seq <= state.seq) return
    state.seq = event.seq
    this.sessions.set(sessionId, state)
    const error = (event.data as { error?: unknown } | null)?.error
    if (typeof error !== 'string' || !error) { delete state.status; return }
    const at = new Date(event.time).toISOString()
    state.status = { sessionId, failures: (state.status?.failures ?? 0) + 1, cause: causeOf(error.slice(0, 4096)), since: state.status?.since ?? at, lastAt: at }
  }

  /** Sessions whose last `COMPACTION_FAILURES` or more compactions all failed. */
  list(): CompactionFailureStatus[] {
    return [...this.sessions.values()].flatMap(state => state.status && state.status.failures >= COMPACTION_FAILURES ? [{ ...state.status }] : [])
  }
}
