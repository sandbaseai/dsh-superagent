import { expect, it } from 'vitest'
import { COMPACTION_FAILURES, CompactionHealth } from '../src/app/compaction-health.ts'
import type { RetryHealthEvent } from '../src/app/retry-health.ts'

const epoch = Date.parse('2026-11-26T08:00:00Z')
const end = (seq: number, error?: string): RetryHealthEvent =>
  ({ type: 'compaction/end', seq, time: epoch + seq * 1000, data: { compactionId: `c${seq}`, turn: seq, ...error ? { error } : {} } })
const credits = '429 {"error":{"message":"Kiro: Kiro credits used up in us-east-1"}}'
const overflow = 'pi-ai detected context overflow for model "kiro/claude-sonnet-5.5"'

it('reports a Session once its last compactions in a row all failed, with the cause of the latest', () => {
  const health = new CompactionHealth()
  for (let seq = 1; seq < COMPACTION_FAILURES; seq++) health.observe('master', end(seq, credits))
  expect(health.list()).toEqual([])
  health.observe('master', end(COMPACTION_FAILURES, credits))
  expect(health.list()).toEqual([{ sessionId: 'master', failures: 3, cause: 'rate limit or credits', since: '2026-11-26T08:00:01.000Z', lastAt: '2026-11-26T08:00:03.000Z' }])
  health.observe('master', end(4, overflow))
  expect(health.list()[0]).toMatchObject({ failures: 4, cause: 'context overflow', since: '2026-11-26T08:00:01.000Z' })
  expect(JSON.stringify(health.list())).not.toMatch(/Kiro|us-east-1/)
})

it('clears the run on a successful compaction and ignores other and replayed events', () => {
  const health = new CompactionHealth()
  for (let seq = 1; seq <= 3; seq++) health.observe('master', end(seq, 'summary is not smaller'))
  expect(health.list()[0]?.cause).toBe('other')
  health.observe('master', end(2))
  health.observe('master', { type: 'turn/end', seq: 4, time: epoch, data: { error: overflow } })
  expect(health.list()).toHaveLength(1)
  health.observe('master', end(5))
  expect(health.list()).toEqual([])
})

it('restores from a snapshot and forgets a disposed Session', () => {
  const health = new CompactionHealth()
  health.restore('worker', [end(1, overflow), end(2, overflow), end(3, overflow)])
  expect(health.list()).toHaveLength(1)
  health.forget('worker')
  expect(health.list()).toEqual([])
})
