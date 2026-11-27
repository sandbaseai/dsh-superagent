/** Cron expressions and the scheduler of scheduled jobs: due minutes, catch-up after a restart, skips, runs by hand, records and health. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Schedules } from '../src/app/schedules.ts'
import { Store } from '../src/app/store.ts'
import { cronMatches, nextRun, parseCron } from '../src/cron.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SchedulesConfigSchema, SettingsSchema, type ScheduleJob } from '../src/policy.ts'
import { deferred } from './fixtures/async.ts'

const SHANGHAI = 'Asia/Shanghai'
const at = (text: string) => Date.parse(text)

describe('cron', () => {
  it('matches the minutes of each field in the job\'s time zone, with ranges, steps, lists and Sunday as 0 or 7', () => {
    const brief = parseCron('5 12-21/3 * * *')
    expect([...brief.hour]).toEqual([12, 15, 18, 21])
    expect(cronMatches(brief, at('2026-11-26T04:05:00Z'), SHANGHAI)).toBe(true)
    expect(cronMatches(brief, at('2026-11-26T04:05:59Z'), SHANGHAI)).toBe(true)
    expect(cronMatches(brief, at('2026-11-26T04:05:00Z'), 'UTC')).toBe(false)
    expect(cronMatches(brief, at('2026-11-26T05:05:00Z'), SHANGHAI)).toBe(false)
    expect(cronMatches(parseCron('0 9 * * 7'), at('2026-11-29T01:00:00Z'), SHANGHAI)).toBe(true)
    expect(cronMatches(parseCron('0 9 * * 1,3'), at('2026-11-29T01:00:00Z'), SHANGHAI)).toBe(false)
  })
  it('matches a day by either the day or the weekday field when both are restricted, and by both otherwise', () => {
    // 2026-11-26 is a Thursday.
    expect(cronMatches(parseCron('0 9 1 * 4'), at('2026-11-26T01:00:00Z'), SHANGHAI)).toBe(true)
    expect(cronMatches(parseCron('0 9 */2 * 4'), at('2026-11-26T01:00:00Z'), SHANGHAI)).toBe(false)
  })
  it('finds the next minute after a time, across days and in a time zone with a half-hour offset', () => {
    const brief = parseCron('5 12-21/3 * * *')
    expect(new Date(nextRun(brief, at('2026-11-26T04:05:00Z'), SHANGHAI)!).toISOString()).toBe('2026-11-26T07:05:00.000Z')
    expect(new Date(nextRun(brief, at('2026-11-26T13:06:00Z'), SHANGHAI)!).toISOString()).toBe('2026-11-27T04:05:00.000Z')
    expect(new Date(nextRun(parseCron('30 9 * * *'), at('2026-11-26T00:00:00Z'), 'Asia/Kolkata')!).toISOString())
      .toBe('2026-11-26T04:00:00.000Z')
    expect(nextRun(parseCron('0 0 31 2 *'), at('2026-11-26T00:00:00Z'), 'UTC')).toBeUndefined()
  })
  it('refuses expressions that are not five valid fields, and the job schema refuses them and unknown time zones', () => {
    for (const text of ['* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', '*/0 * * * *', 'a * * * *']) {
      expect(() => parseCron(text), text).toThrow()
    }
    const job = { id: 'brief', name: 'Brief', cron: '5 12-21/3 * * *', timeZone: SHANGHAI, command: 'true' }
    expect(SchedulesConfigSchema.parse({ jobs: [job] }).jobs[0]).toMatchObject({ enabled: true, timeoutMinutes: 30 })
    expect(() => SchedulesConfigSchema.parse({ jobs: [{ ...job, cron: '5 25 * * *' }] })).toThrow()
    expect(() => SchedulesConfigSchema.parse({ jobs: [{ ...job, timeZone: 'Mars/Olympus' }] })).toThrow()
    expect(() => SchedulesConfigSchema.parse({ jobs: [job, job] })).toThrow('Duplicate job IDs')
  })
})

interface Call { argv: readonly string[]; cwd: string; finish: (exitCode: number | null, stdout?: string, stderr?: string) => void }
let directory: string
let store: Store
let board: HealthBoard
let calls: Call[]
let lifetime: AbortController
let paused: boolean
const subprocess = { spawn: vi.fn((spec: { argv: readonly string[]; cwd: string; signal?: AbortSignal }) => {
  const done = deferred<{ exitCode: number | null; signal: string | null }>()
  const output = { stdout: '', stderr: '' }
  calls.push({ argv: spec.argv, cwd: spec.cwd, finish: (exitCode, stdout = '', stderr = '') => {
    Object.assign(output, { stdout, stderr }); done.resolve({ exitCode, signal: null })
  } })
  spec.signal?.addEventListener('abort', () => { done.resolve({ exitCode: null, signal: 'SIGTERM' }) })
  const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
  return { done: done.promise, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
}) }
const BRIEF: ScheduleJob = { id: 'brief', name: 'Alarm brief', enabled: true, cron: '5 12-21/3 * * *', timeZone: SHANGHAI,
  command: 'oncall-ticket-digest --brief', timeoutMinutes: 30 }
function configure(jobs: ScheduleJob[]): void { store.saveSettings(SettingsSchema.parse({ ...store.settings(), schedules: { jobs } })) }
function scheduler(): Schedules {
  board = new HealthBoard()
  return new Schedules({ store, subprocess: subprocess as never, health: board.claim('schedules'), lifetime: lifetime.signal,
    paused: () => paused, directory: '/home/oncall' })
}
const runs = (job = 'brief') => store.get(KV.schedules.runs(job)) ?? []

beforeEach(() => {
  vi.useFakeTimers({ now: at('2026-11-26T04:04:30Z'), toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  directory = mkdtempSync(join(tmpdir(), 'schedules-'))
  store = new Store(join(directory, 'db.sqlite'))
  board = new HealthBoard()
  calls = []
  lifetime = new AbortController()
  paused = false
  subprocess.spawn.mockClear()
  configure([BRIEF])
})
afterEach(async () => {
  lifetime.abort()
  await Promise.resolve()
  store.close()
  rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('Schedules', () => {
  it('runs a job at its minute with /bin/sh in its directory, records the outcome and the output, and shows the next run', async () => {
    const schedules = scheduler()
    schedules.start()
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls.map(call => [call.argv, call.cwd])).toEqual([[['/bin/sh', '-c', BRIEF.command], '/home/oncall']])
    expect(runs()).toMatchObject([{ reason: 'schedule', slot: '2026-11-26T04:05:00.000Z', outcome: 'running' }])
    expect(schedules.view().jobs[0]).toMatchObject({ running: true, next: '2026-11-26T07:05:00.000Z' })
    calls[0]!.finish(0, 'posted')
    await schedules.idle()
    expect(runs()).toMatchObject([{ outcome: 'succeeded', exitCode: 0, stdout: 'posted', endedAt: '2026-11-26T04:05:00.000Z' }])
    expect(board.all.schedules).toMatchObject({ state: 'ready', detail: '1 scheduled jobs' })
    // The next minutes until 15:05 start nothing.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(calls).toHaveLength(1)
  })

  it('reports an error while a job\'s last run failed, with the last line it wrote, until a run succeeds', async () => {
    const schedules = scheduler()
    schedules.start()
    await vi.advanceTimersByTimeAsync(30_000)
    calls[0]!.finish(1, '', 'oncall-ticket-digest: the gateway answered 429\n')
    await schedules.idle()
    expect(runs()[0]).toMatchObject({ outcome: 'failed', exitCode: 1 })
    expect(board.all.schedules).toMatchObject({ state: 'error', detail: 'Alarm brief: oncall-ticket-digest: the gateway answered 429' })
    schedules.run('brief')
    calls[1]!.finish(0)
    await schedules.idle()
    expect(runs().map(run => [run.reason, run.outcome])).toEqual([['manual', 'succeeded'], ['schedule', 'failed']])
    expect(board.all.schedules).toMatchObject({ state: 'ready' })
  })

  it('runs a minute a restart missed once when it is at most 15 minutes old, and marks the run the stop interrupted', async () => {
    const first = scheduler()
    first.start()
    await vi.advanceTimersByTimeAsync(20_000)
    lifetime.abort()
    await first.idle()
    expect(runs()).toEqual([])
    // Down from 12:04 to 12:12: the 12:05 minute runs once at the start.
    vi.setSystemTime(at('2026-11-26T04:12:10Z'))
    lifetime = new AbortController()
    const second = scheduler()
    second.start()
    expect(runs()).toMatchObject([{ slot: '2026-11-26T04:05:00.000Z', outcome: 'running' }])
    lifetime.abort()
    await second.idle()
    expect(runs()).toMatchObject([{ outcome: 'interrupted' }])
    // A run a crash left running reads as interrupted at the next start; a minute 25 minutes old does not run.
    store.set(KV.schedules.runs('brief'), [{ ...runs()[0]!, outcome: 'running' }])
    store.set(KV.schedules.tick, '2026-11-26T04:00:00.000Z')
    vi.setSystemTime(at('2026-11-26T04:30:00Z'))
    lifetime = new AbortController()
    scheduler().start()
    expect(runs().map(run => run.outcome)).toEqual(['interrupted'])
    expect(calls).toHaveLength(1)
  })

  it('records a scheduled minute as skipped while processing is paused or the previous run continues, and runs by hand while paused', async () => {
    configure([{ ...BRIEF, cron: '* * * * *' }])
    const schedules = scheduler()
    schedules.start()
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs()[0]).toMatchObject({ outcome: 'skipped', skipped: 'running' })
    expect(() => schedules.run('brief')).toThrow('running already')
    calls[0]!.finish(0)
    await schedules.idle()
    paused = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs()[0]).toMatchObject({ outcome: 'skipped', skipped: 'paused' })
    expect(calls).toHaveLength(1)
    schedules.run('brief')
    expect(calls).toHaveLength(2)
    expect(() => schedules.run('missing')).toThrow('Unknown scheduled job')
  })

  it('runs no job that is off, and keeps the last 20 runs of a job', async () => {
    configure([{ ...BRIEF, cron: '* * * * *', enabled: false }])
    const schedules = scheduler()
    schedules.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(calls).toEqual([])
    expect(schedules.view().jobs[0]).toMatchObject({ next: null })
    for (let index = 0; index < 25; index++) {
      schedules.run('brief')
      calls.at(-1)!.finish(0)
      await schedules.idle()
    }
    expect(runs()).toHaveLength(20)
  })
})
