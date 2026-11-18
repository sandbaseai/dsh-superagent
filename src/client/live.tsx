/** Live view: Sources, the Router and the worker slots as connected cards, a one-line state, and how the latest Ticket went. */
import type { ReactNode } from 'react'
import type { LiveView } from '../app/views/live.ts'
import { usePoll } from './api.ts'
import { Dot } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { actorName, reasonLabel, readableMarkers, valueLabel, type T } from './text.ts'
import { Hint, LoadState, Section, SessionButton, When } from './widgets.tsx'

const POLL_MS = 2000
/** The span a worker's bar fills: the background limit after a turn, 30 minutes. */
const BAR_MS = 30 * 60_000
/** A turn with no tool call, result or model answer for this long looks stuck. */
export const QUIET_MS = 5 * 60_000
type Row = LiveView['tickets'][number]
type Trace = NonNullable<LiveView['trace']>
export type WorkState = 'turn' | 'background' | 'person' | 'queued' | 'idle'

export const workState = (row: Row): WorkState => row.slot ? row.turn ? 'turn' : 'background'
  : row.stage === 'person' ? 'person' : row.stage === 'working' ? 'queued' : 'idle'
const DOT = { turn: 'ongoing', background: 'warning', person: 'error', queued: 'idle', idle: 'done' } as const

const ms = (from: string | undefined, to: string | undefined) => from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : 0
export const tokens = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
  : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
export function duration(t: T, value: number): string {
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return t('liveSeconds', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('liveMinutes', { n: minutes })
  return t('liveHours', { h: Math.floor(minutes / 60), m: minutes % 60 })
}

function Card({ state, title, sub, chip, onClick, session }: { state: 'run' | 'idle' | 'error'; title: string; sub: string; chip?: string;
  onClick?: () => void; session?: ReactNode }) {
  return <div className="dt-live-card" data-state={state}>
    <span className="dt-live-card-title"><span className="dt-live-led" />{title}</span>
    <span className="dt-live-card-sub">{sub}</span>
    {chip && (onClick ? <button type="button" className="dt-live-chip" onClick={onClick}>{chip} ›</button>
      : <span className="dt-live-chip">{chip}</span>)}
    {session}
  </div>
}
const Link = ({ flowing }: { flowing: boolean }) => <span className="dt-live-link" data-flowing={flowing} aria-hidden="true" />

function Slot({ row, now }: { row: Row | undefined; now: string }) {
  const { t, navigate } = usePanel()
  if (!row) return <li className="dt-live-slot" data-state="free"><span className="dt-live-slot-dot" />
    <span className="dt-live-slot-title">{t('liveSlotFree')}</span></li>
  const state = workState(row), elapsed = ms(row.startedAt, now)
  const activity = 'activity' in row ? row.activity : undefined
  const quiet = row.turn && activity?.lastAt ? ms(activity.lastAt, now) : 0
  return <li className="dt-live-slot" data-state={state} data-quiet={quiet >= QUIET_MS || undefined}>
    <span className="dt-live-slot-dot" />
    <button type="button" className="dt-live-slot-title dt-textlink" onClick={() => navigate({ page: 'execution', id: row.id })}>
      {readableMarkers(t, row.title)}</button>
    {row.source && <span className="dt-live-tag">{valueLabel(t, 'source', row.source)}</span>}
    <span className="dt-live-slot-state">{t(`live.${state}`)}{row.jobs > 0 && ` · ${t('liveJobs', { count: row.jobs })}`}
      {row.startedAt && ` · ${duration(t, elapsed)}`}</span>
    {row.sessionId ? <SessionButton sessionId={row.sessionId} label={t('liveOpenWorker')} /> : <span />}
    {activity && <span className="dt-live-activity">
      {activity.lastTool && <span className="dt-live-tool" title={activity.lastTool.detail}>
        <code>{activity.lastTool.name}</code>{activity.lastTool.detail && <span className="dt-live-tool-detail">{activity.lastTool.detail}</span>}
      </span>}
      {quiet >= QUIET_MS ? <span className="dt-live-quiet">{t('liveQuiet', { time: duration(t, quiet) })}</span>
        : activity.lastAt && <span>{t('liveAgo', { time: duration(t, ms(activity.lastAt, now)) })}</span>}
      {activity.subagents > 0 && <span>{t('liveSubagents', { count: activity.subagents })}</span>}
      <span>{t('liveTools', { count: activity.tools })}{activity.errors > 0 && ` · ${t('liveToolErrors', { count: activity.errors })}`}</span>
      {activity.tokens > 0 && <span>{t('liveTokens', { count: tokens(activity.tokens) })}</span>}
    </span>}
    <span className="dt-live-bar" title={t('liveBarHint')}><span style={{ width: `${Math.min(100, elapsed / BAR_MS * 100)}%` }} /></span>
  </li>
}

function Topology({ data }: { data: LiveView }) {
  const { t, navigate } = usePanel()
  const { state } = usePanelData()
  const { flow, router, executor, sources } = data
  const trouble = router.overdue + router.unavailable
  const routerState = trouble ? 'error' : router.busy || router.evaluating.length ? 'run' : 'idle'
  const working = data.tickets.filter(row => row.slot)
  const free = Math.max(0, Math.min(executor.maxWorkers, 8) - working.length)
  return <div className="dt-live-topology">
    <Card state={sources.failing ? 'error' : flow.received ? 'run' : 'idle'} title={t('liveSources')}
      sub={`${t('liveArrived', { count: flow.received })} · ${t('liveFiltered', { count: flow.filtered })}`} />
    <Link flowing={flow.triggers > 0} />
    <Card state={routerState} title={t('liveRouter')} sub={t('liveRouterSub')}
      chip={trouble ? t('liveRouterTrouble', { count: trouble }) : router.evaluating.length
        ? t('liveEvaluating', { count: router.evaluating.length }) : t(router.busy ? 'liveRouterBusy' : 'liveRouterIdle')}
      onClick={trouble ? () => navigate({ page: 'overview' }) : undefined}
      session={state?.masterId && <SessionButton sessionId={state.masterId} label={t('liveOpenRouter')} />} />
    <Link flowing={working.length > 0} />
    <div className="dt-live-floor" data-state={executor.paused ? 'paused' : working.length ? 'run' : 'idle'}>
      <div className="dt-live-floor-head">
        <span className="dt-live-card-title"><span className="dt-live-led" />{t('liveWorkers')}</span>
        <span className="dt-live-chip">{executor.paused ? t('livePaused') : t('liveSlots', { running: executor.running,
          max: executor.maxWorkers })}</span>
      </div>
      <ul className="dt-live-slots">
        {working.map(row => <Slot key={row.id} row={row} now={data.at} />)}
        {Array.from({ length: free }, (_, index) => <Slot key={`free-${index}`} row={undefined} now={data.at} />)}
      </ul>
    </div>
  </div>
}

/** The state in one sentence, beside the counts a supervisor reads first. */
function Headline({ data }: { data: LiveView }) {
  const { t } = usePanel()
  const working = data.tickets.filter(row => row.slot).length
  const parts = [data.router.evaluating.length ? t('liveSayEvaluating', { count: data.router.evaluating.length }) : t('liveSayRouterIdle'),
    working ? t('liveSayWorking', { count: working }) : t('liveSayNoWorker'),
    ...data.executor.queued ? [t('liveSayQueued', { count: data.executor.queued })] : [],
    ...data.executor.person ? [t('liveSayPerson', { count: data.executor.person })] : []]
  const big = (value: number, label: string) => <span className="dt-live-big"><b>{value}</b><span>{label}</span></span>
  return <div className="dt-live-headline">
    <p>{parts.join(t('liveSayJoin'))}{t('liveSayEnd')}</p>
    <div className="dt-live-bigs">
      {big(data.flow.received, t('flowReceivedLabel'))}{big(data.flow.accepted, t('flowAcceptedLabel'))}
      {big(data.problems, t('problems'))}
    </div>
  </div>
}

function Step({ state, children }: { state: 'done' | 'now' | 'note'; children: ReactNode }) {
  return <li className="dt-live-step" data-state={state}><span className="dt-live-step-dot" /><div>{children}</div></li>
}
function TraceView({ trace, now }: { trace: Trace; now: string }) {
  const { t, navigate } = usePanel()
  const { trigger, decision, report } = trace
  const end = trace.endedAt ?? (trace.stage === 'working' ? now : report?.at ?? now)
  const segments = ([
    { key: 'eval', value: ms(trigger?.at, decision?.at) },
    { key: 'slot', value: ms(decision?.at ?? trace.createdAt, trace.startedAt) },
    { key: 'work', value: ms(trace.startedAt, end) },
  ] as const).filter(segment => segment.value > 0)
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  return <Section title={t('liveTraceTitle')} action={<button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate({ page: 'execution', id: trace.ticketId })}>{t('liveOpenTicket')}</button>}>
    <ul className="dt-live-steps">
      {trigger && <Step state="done">{t('liveTraceTrigger', { source: valueLabel(t, 'source', trigger.source),
        actor: actorName(t, trigger.actor) })}<q>{readableMarkers(t, trigger.preview)}</q> <When at={trigger.at} /></Step>}
      {decision && <Step state="done">{t('liveTraceDecision', { kind: t(`decision.${decision.kind}`),
        strength: t(`strength.${decision.strength}`) })}{reasonLabel(t, decision.reason)}
        {trigger && <span className="dt-live-muted"> · {t('liveTook', { time: duration(t, ms(trigger.at, decision.at)) })}</span>}</Step>}
      <Step state={trace.startedAt ? 'done' : 'now'}>{t('liveTraceTicket', { title: readableMarkers(t, trace.title) })}
        {trace.startedAt ? <span className="dt-live-muted"> · {t('liveTraceStarted', { time: duration(t, ms(decision?.at ?? trace.createdAt,
          trace.startedAt)) })}</span> : <span className="dt-live-muted"> · {t('live.queued')}</span>}</Step>
      {report && <Step state={trace.endedAt ? 'done' : 'now'}>{t('liveTraceReport', { state: t(`report.${report.state}`) })}
        {report.summary} <When at={report.at} /></Step>}
      {total > 0 && <Step state="note">
        <span>{t('liveTimeSpent')}</span>
        <span className="dt-live-stack">{segments.map(segment => <span key={segment.key} data-part={segment.key}
          style={{ flexGrow: segment.value }} />)}</span>
        <span className="dt-live-legend">{segments.map(segment => <span key={segment.key} data-part={segment.key}>
          {t(`liveSpent.${segment.key}`)} {duration(t, segment.value)}</span>)}</span>
      </Step>}
    </ul>
  </Section>
}

function TicketRow({ row }: { row: Row }) {
  const { t, navigate } = usePanel()
  const state = workState(row)
  return <li className="dt-row dt-link">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <Dot state={DOT[state]} label={t(`live.${state}`)} />
        <button type="button" className="dt-open" onClick={() => navigate({ page: 'execution', id: row.id })}>
          {readableMarkers(t, row.title)}</button>
      </div>
      <div className="dt-row-meta">
        <span>{t(`live.${state}`)}</span>
        {row.source && <span>{valueLabel(t, 'source', row.source)}</span>}
        {row.jobs > 0 && <span>{t('liveJobs', { count: row.jobs })}</span>}
        {row.startedAt && <span>{t('liveStarted')} <When at={row.startedAt} /></span>}
      </div>
    </div>
  </li>
}

export function LivePage() {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET live'), [], POLL_MS)
  if (!data) return <LoadState error={error} loading />
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Hint>{t('liveIntro')}</Hint>
    <Topology data={data} />
    <Headline data={data} />
    {data.trace && <TraceView trace={data.trace} now={data.at} />}
    {data.router.evaluating.length > 0 && <Section title={t('liveEvaluatingTitle')} count={data.router.evaluating.length}>
      <ul className="dt-list">{data.router.evaluating.map(thread => <li key={thread.key} className="dt-row dt-link">
        <div className="dt-row-main">
          <div className="dt-row-title"><Dot state="ongoing" />
            <button type="button" className="dt-open" onClick={() => navigate({ page: 'trigger', id: thread.key })}>
              {readableMarkers(t, thread.title)}</button></div>
          <div className="dt-row-meta"><span>{valueLabel(t, 'source', thread.source)}</span>
            <span>{t('liveStarted')} <When at={thread.startedAt} /></span></div>
        </div>
      </li>)}</ul>
    </Section>}
    <Section title={t('liveTicketsTitle')} count={data.total}>
      {data.tickets.length ? <ul className="dt-list">{data.tickets.map(row => <TicketRow key={row.id} row={row} />)}</ul>
        : <Hint>{t('liveNone')}</Hint>}
      {data.total > data.tickets.length && <Hint>{t('liveMore', { count: data.total - data.tickets.length })}</Hint>}
    </Section>
  </>
}
