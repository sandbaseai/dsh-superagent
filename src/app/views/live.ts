/** Live view: the whole pipeline at once, from Sources through Router and workers to replies, for watching the agent run. */
import { latestAssignment, latestReport, ticketStage, type Ticket } from '../../core/index.ts'
import type { Activity } from '../../executor/activity.ts'
import { workerSessionId, type WorkerActivity } from '../../executor/dsh.ts'
import { newestFirst, snapshot, threadSummary, type Snapshot, type ViewHost } from './records.ts'
import { preview } from './text.ts'
import type { OverviewView } from './overview.ts'

/** How many open Tickets the view lists; the counts above it still cover all of them. */
const SHOWN = 24
/** Workers holding a slot first, then those waiting for a person, queued, and waiting for a Trigger. */
const ORDER = { slot: 0, person: 1, working: 2, idle: 3, ended: 4 } as const

/** How the most recent Ticket went: its Trigger, the Eval's Decision, the start of its worker and what the worker last said. */
function trace(view: Snapshot, ticket: Ticket) {
  const { store } = view
  const trigger = store.triggers.get(ticket.origin.triggerId)
  const decision = store.decisions.get(ticket.decisionId)
  const report = latestReport(ticket)
  return { ticketId: ticket.id, title: ticket.title, ...ticketStage(ticket), createdAt: ticket.createdAt,
    trigger: trigger && { source: trigger.source, actor: view.actor(trigger.actor, trigger.human), at: trigger.at, preview: preview(trigger.text) },
    decision: decision && { kind: decision.kind, reason: decision.reason, strength: decision.strength, at: decision.at },
    startedAt: ticket.assignments.find(assignment => assignment.startedAt)?.startedAt,
    report: report && { state: report.state, summary: preview(report.summary.split('\n')[0] ?? ''), at: report.at },
    endedAt: ticket.ended?.at }
}

const HOUR = 3_600_000
/** A wait for a slot longer than this means the workers were all taken. */
const WAITED_MS = 60_000
const quantile = (sorted: number[], q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0
const spread = (values: number[]) => {
  const sorted = values.slice().sort((a, b) => a - b)
  return { count: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95) }
}
/**
 * The last 24 hours of Tickets by their first Assignment: how long it waited for a slot, how long its worker took to its
 * first Report that is not progress, and the Tickets opened in each hour with how many of them waited.
 */
export function dayStats(tickets: readonly Ticket[], now = Date.now()) {
  const since = now - 24 * HOUR
  const hours = Array.from({ length: 24 }, (_, index) => ({ at: new Date(since + index * HOUR).toISOString(), opened: 0, waited: 0 }))
  const waits: number[] = [], works: number[] = []
  for (const ticket of tickets) {
    const created = Date.parse(ticket.createdAt)
    if (!(created >= since)) continue
    const hour = hours[Math.min(23, Math.floor((created - since) / HOUR))]!
    hour.opened++
    const first = ticket.assignments[0]
    if (!first?.startedAt) continue
    const wait = Date.parse(first.startedAt) - Date.parse(first.createdAt)
    waits.push(wait)
    if (wait > WAITED_MS) hour.waited++
    const done = first.report && first.report.state !== 'progress' ? first.report.at : undefined
    if (done) works.push(Date.parse(done) - Date.parse(first.startedAt))
  }
  return { wait: { ...spread(waits), waited: waits.filter(value => value > WAITED_MS).length }, work: spread(works), hours }
}

export function liveView(host: ViewHost, overview: OverviewView, workers: readonly WorkerActivity[], routerBusy: boolean,
  activity: (ticketIds: readonly string[]) => ReadonlyMap<string, Activity>) {
  const view = snapshot(host)
  const { store } = view
  const active = new Map(workers.map(worker => [worker.ticketId, worker]))
  const row = (ticket: Ticket) => {
    const stage = ticketStage(ticket), worker = active.get(ticket.id)
    const assignment = latestAssignment(ticket)
    return { id: ticket.id, title: ticket.title, ...stage, slot: !!worker, turn: worker?.turn ?? false, jobs: worker?.jobs ?? 0,
      source: ticket.channels[0]?.source, startedAt: assignment?.startedAt, updatedAt: ticket.updatedAt,
      // Every started Assignment runs in the Ticket's one worker Session.
      sessionId: ticket.assignments.some(item => item.startedAt) ? workerSessionId(ticket.id) : '' }
  }
  const rank = (item: ReturnType<typeof row>) => item.slot ? ORDER.slot : ORDER[item.stage]
  const sorted = store.tickets.open().sort(newestFirst).map(row).sort((a, b) => rank(a) - rank(b)).slice(0, SHOWN)
  const done = activity(sorted.filter(item => item.sessionId).map(item => item.id))
  const open = sorted.map(item => { const value = done.get(item.id); return value ? { ...item, activity: value } : item })
  const total = store.tickets.open().length
  const evaluating = store.threads.active().filter(thread => thread.evaluating).map(thread => {
    const summary = threadSummary(view, thread)
    return { key: summary.key, title: summary.title, source: summary.source, startedAt: summary.evaluating!.startedAt,
      deadline: summary.evaluating!.deadline }
  })
  const problems = overview.problems.map(problem => problem.kind)
  const latest = [...store.tickets.open(), ...store.tickets.list().filter(ticket => ticket.ended)].sort(newestFirst)[0]
  return {
    at: new Date().toISOString(),
    router: { busy: routerBusy, evaluating, overdue: problems.filter(kind => kind === 'eval-overdue').length,
      unavailable: problems.filter(kind => kind === 'eval-unavailable').length },
    flow: overview.flow,
    executor: { ...overview.executor, paused: store.settings().paused, person: overview.person.length },
    outbox: { failing: problems.filter(kind => kind === 'outgoing').length },
    sources: { failing: problems.filter(kind => kind === 'source-error' || kind === 'no-source' || kind === 'setup').length },
    problems: problems.length,
    tickets: open, total,
    trace: latest ? trace(view, latest) : undefined,
    day: dayStats(store.tickets.list()),
  }
}
export type LiveView = ReturnType<typeof liveView>
