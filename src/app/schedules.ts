/** The scheduler of scheduled jobs: shell commands the host runs at the minutes of their cron expressions, and their recent runs. */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { UserError } from '../core/index.ts'
import { cronMatches, nextRun, parseCron } from '../cron.ts'
import type { HealthEntry } from '../infra/health.ts'
import { KV } from '../kv.ts'
import type { ScheduleJob } from '../policy.ts'
import type { Store } from './store.ts'

const MINUTE = 60_000
/** How far back the scheduler runs a job whose minute it missed, such as while a deploy restarted the service. */
export const CATCH_UP_MS = 15 * MINUTE
const KEPT_RUNS = 20
const OUTPUT_BYTES = 16 * 1024
const OUTPUT_CHARS = 4000

export interface ScheduleRun {
  id: string
  reason: 'schedule' | 'manual'
  /** The scheduled minute the run is for. */
  slot?: string
  startedAt: string
  endedAt?: string
  outcome: 'running' | 'succeeded' | 'failed' | 'timedOut' | 'interrupted' | 'skipped'
  /** Why a scheduled minute did not run: processing was paused, or the job's previous run had not finished. */
  skipped?: 'paused' | 'running'
  exitCode?: number | null
  /** The ends of the command's output. */
  stdout?: string
  stderr?: string
}

export interface SchedulesHost {
  readonly store: Pick<Store, 'settings' | 'get' | 'set' | 'keys'>
  readonly subprocess: Pick<SubprocessRuntime, 'spawn'>
  readonly health: HealthEntry
  /** Aborted when the service stops, which also stops running commands. */
  readonly lifetime: AbortSignal
  /** While processing is paused or setup waits, scheduled minutes are recorded as skipped. */
  paused(): boolean
  /** Where commands start; defaults to the service user's home directory, like cron's. */
  readonly directory?: string
}

const now = (): string => new Date().toISOString()
const tail = (text: string): string => text.length > OUTPUT_CHARS ? `…${text.slice(-OUTPUT_CHARS)}` : text
const lastLine = (text: string): string => text.trim().split('\n').at(-1)?.slice(0, 300) ?? ''

/**
 * Runs the scheduled jobs of the `schedules` settings block: once a minute it starts each enabled job whose cron expression
 * names a minute since the previous round (at most `CATCH_UP_MS` back, so a restart still runs a minute it missed), one run
 * per job at a time, and keeps each job's last runs in the Store. Runtime starts it with the background loops and waits for
 * running commands at shutdown; the management routes read `view` and start a run with `run`. Its `schedules` health entry
 * reports an error while an enabled job's last finished run failed in this process.
 */
export class Schedules {
  private readonly running = new Map<string, Promise<void>>()
  /** The failure of each job whose last finished run failed. */
  private readonly failures = new Map<string, string>()
  private timer?: ReturnType<typeof setTimeout>
  constructor(private readonly host: SchedulesHost) {
    host.lifetime.addEventListener('abort', () => { clearTimeout(this.timer) }, { once: true })
  }
  private jobs(): ScheduleJob[] { return this.host.store.settings().schedules.jobs }
  start(): void {
    // A run the previous process left running did not finish.
    for (const key of this.host.store.keys(KV.schedules.runs)) {
      const runs = this.host.store.get(key) ?? []
      if (runs.some(run => run.outcome === 'running')) {
        this.host.store.set(key, runs.map(run => run.outcome === 'running' ? { ...run, outcome: 'interrupted' as const, endedAt: now() } : run))
      }
    }
    this.tick()
  }
  /** Resolves once no command runs, as after the lifetime aborted them. */
  async idle(): Promise<void> { await Promise.allSettled([...this.running.values()]) }
  /**
   * Starts a run of job `id` now, whatever its schedule says and even while processing is paused.
   * @throws UserError `unknownJob` when no job has that id, `jobRunning` while its previous run has not finished.
   */
  run(id: string): { started: true } {
    const job = this.jobs().find(item => item.id === id)
    if (!job) throw new UserError('unknownJob', { job: id })
    if (this.running.has(id)) throw new UserError('jobRunning', { job: job.name })
    this.launch(job, 'manual')
    return { started: true }
  }
  view() {
    const at = Date.now()
    const jobs = this.jobs().map(job => {
      const next = job.enabled ? nextRun(parseCron(job.cron), at, job.timeZone) : undefined
      return { ...job, running: this.running.has(job.id), next: next === undefined ? null : new Date(next).toISOString(),
        runs: this.host.store.get(KV.schedules.runs(job.id)) ?? [] }
    })
    return { paused: this.host.paused(), jobs }
  }
  private tick(): void {
    if (this.host.lifetime.aborted) return
    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const last = Date.parse(this.host.store.get(KV.schedules.tick) ?? '')
    const from = Number.isFinite(last) ? Math.max(last + MINUTE, minute - CATCH_UP_MS) : minute
    for (const job of this.jobs()) {
      if (!job.enabled) continue
      const cron = parseCron(job.cron)
      // Several missed minutes of one job make one run, for the latest of them.
      for (let at = minute; at >= from; at -= MINUTE) {
        if (cronMatches(cron, at, job.timeZone)) { this.launch(job, 'schedule', new Date(at).toISOString()); break }
      }
    }
    if (from <= minute) this.host.store.set(KV.schedules.tick, new Date(minute).toISOString())
    this.report()
    this.timer = setTimeout(() => { this.tick() }, minute + MINUTE - Date.now())
    this.timer.unref?.()
  }
  private launch(job: ScheduleJob, reason: ScheduleRun['reason'], slot?: string): void {
    const base = { id: randomUUID(), reason, ...slot ? { slot } : {}, startedAt: now() }
    const skipped = this.running.has(job.id) ? 'running' : reason === 'schedule' && this.host.paused() ? 'paused' : undefined
    if (skipped) { this.record(job.id, { ...base, outcome: 'skipped', skipped, endedAt: base.startedAt }); return }
    this.record(job.id, { ...base, outcome: 'running' })
    const done = this.execute(job, base.id).finally(() => { this.running.delete(job.id) })
    this.running.set(job.id, done)
  }
  private async execute(job: ScheduleJob, id: string): Promise<void> {
    const timeout = AbortSignal.timeout(job.timeoutMinutes * MINUTE)
    let ended: Pick<ScheduleRun, 'outcome' | 'exitCode' | 'stdout' | 'stderr'>
    try {
      const handle = this.host.subprocess.spawn({ argv: ['/bin/sh', '-c', job.command], cwd: this.host.directory ?? homedir(), graceMs: 5000,
        signal: AbortSignal.any([this.host.lifetime, timeout]),
        stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_BYTES }, stderr: { maxBytes: OUTPUT_BYTES } } })
      const { exitCode } = await handle.done
      const read = (reader: SubprocessOutputReader | undefined) => tail(reader?.readFrom(0).text ?? '')
      const outcome = exitCode === 0 ? 'succeeded' : timeout.aborted ? 'timedOut' : this.host.lifetime.aborted ? 'interrupted' : 'failed'
      ended = { outcome, exitCode, stdout: read(handle.collected.stdout), stderr: read(handle.collected.stderr) }
    } catch (error) {
      ended = { outcome: 'failed', stderr: tail(error instanceof Error ? error.message : String(error)) }
    }
    if (ended.outcome === 'succeeded') this.failures.delete(job.id)
    else if (ended.outcome !== 'interrupted') {
      this.failures.set(job.id, ended.outcome === 'timedOut' ? `timed out after ${job.timeoutMinutes} min`
        : lastLine(ended.stderr ?? '') || `exited with ${ended.exitCode}`)
    }
    const runs = this.host.store.get(KV.schedules.runs(job.id)) ?? []
    this.host.store.set(KV.schedules.runs(job.id), runs.map(run => run.id === id ? { ...run, ...ended, endedAt: now() } : run))
    this.report()
  }
  private record(job: string, run: ScheduleRun): void {
    const runs = this.host.store.get(KV.schedules.runs(job)) ?? []
    this.host.store.set(KV.schedules.runs(job), [run, ...runs].slice(0, KEPT_RUNS))
  }
  private report(): void {
    const jobs = this.jobs().filter(job => job.enabled)
    const failed = jobs.filter(job => this.failures.has(job.id))
    this.host.health.set(failed.length
      ? { state: 'error', detail: failed.map(job => `${job.name}: ${this.failures.get(job.id)}`).join('; '), at: now() }
      : { state: 'ready', detail: `${jobs.length} scheduled jobs`, at: now() })
  }
}
