/** Live view: the whole pipeline at once, from Sources through Router and workers to replies, for watching the agent run. */
import { latestAssignment, latestReport, ticketStage, type Ticket } from '../../core/index.ts'
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

export function liveView(host: ViewHost, overview: OverviewView, workers: readonly WorkerActivity[], routerBusy: boolean) {
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
  const open = store.tickets.open().sort(newestFirst).map(row).sort((a, b) => rank(a) - rank(b))
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
    tickets: open.slice(0, SHOWN), total: open.length,
    trace: latest ? trace(view, latest) : undefined,
  }
}
export type LiveView = ReturnType<typeof liveView>
