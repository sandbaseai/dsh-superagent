/** Scheduled jobs: their status page (next and recent runs, run now) and their settings group (the jobs and their commands). */
import { useState } from 'react'
import { LIMITS } from '../limits.ts'
import { usePoll, type ScheduleJobView, type ScheduleRunView, type Settings } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, InfoTip, Input, Switch, type DotState } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { ConfigHistory, Field, Fields, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { ConfirmButton, Hint, LabelValue, LoadState, Section, StatusHead, When } from './widgets.tsx'

function runState(run: ScheduleRunView | undefined, running: boolean): DotState {
  if (running) return 'ongoing'
  if (!run) return 'idle'
  return run.outcome === 'succeeded' ? 'done' : run.outcome === 'failed' || run.outcome === 'timedOut' ? 'error' : 'warning'
}
const seconds = (run: ScheduleRunView): number | undefined =>
  run.endedAt ? Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000) : undefined

function RunLine({ run }: { run: ScheduleRunView }) {
  const { t } = usePanel()
  const output = [run.stderr, run.stdout].filter(Boolean).join('\n').trim()
  const took = seconds(run)
  return <li className="dt-row">
    <Dot state={runState(run, run.outcome === 'running')} />
    <div className="dt-row-main">
      <div className="dt-row-title">{t(`runOutcome.${run.outcome}`)}{run.skipped && <span className="dt-hint">{t(`runSkipped.${run.skipped}`)}</span>}</div>
      <div className="dt-row-meta">
        <When at={run.startedAt} /><span>{t(`runReason.${run.reason}`)}</span>
        {took !== undefined && run.outcome !== 'skipped' && <LabelValue label={t('runTook')} value={t('runSeconds', { seconds: String(took) })} />}
        {run.exitCode != null && run.exitCode !== 0 && <LabelValue label={t('runExit')} value={run.exitCode} />}
      </div>
      {output && <pre className="dt-pre">{output}</pre>}
    </div>
  </li>
}

function JobRow({ job, onRun }: { job: ScheduleJobView; onRun: () => Promise<unknown> }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const last = job.runs[0]
  const state = runState(last, job.running)
  return <li className="dt-row">
    <Dot state={state} label={job.running ? t('jobRunning') : last ? t(`runOutcome.${last.outcome}`) : t('jobNeverRan')} />
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-row-name">{job.name}</span>
        {!job.enabled && <span className="dt-status-text" data-state="idle">{t('jobOff')}</span>}
        {job.running && <span className="dt-status-text" data-state="ongoing">{t('jobRunning')}</span>}</div>
      <div className="dt-row-meta">
        <span className="dt-mono">{job.cron}</span><span>{job.timeZone}</span>
        {job.next && <LabelValue label={t('jobNext')} value={<When at={job.next} />} />}
        {last && <LabelValue label={t('jobLast')} value={<>{t(`runOutcome.${last.outcome}`)} · <When at={last.startedAt} /></>} />}
      </div>
      {job.runs.length > 0 && <DisclosureRow icon={<Icon name="history" />} title={t('jobRuns')} open={open} onToggle={() => setOpen(!open)}>
        <div className="dt-disclosure-body"><ul className="dt-list">{job.runs.map(run => <RunLine key={run.id} run={run} />)}</ul></div>
      </DisclosureRow>}
    </div>
    <div className="dt-row-actions">
      {!job.running && <ConfirmButton variant="outline" icon="play" label={t('jobRunNow')} title={t('jobRunNow')}
        message={t('jobRunNowConfirm', { name: job.name })} onConfirm={onRun} />}
    </div>
  </li>
}

export function ScheduleStatus() {
  const { t, call, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET schedules'), [call])
  const run = async (id: string) => { await call('POST schedules/:id/run', { id }); notify(t('jobStarted')); await reload() }
  return <>
    <StatusHead hint={t('scheduleStatusIntro')} settings="schedule" />
    {data?.paused && <Hint>{t('schedulePaused')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.jobs.length ? <ul className="dt-list">{data.jobs.map(job => <JobRow key={job.id} job={job}
      onRun={() => run(job.id)} />)}</ul> : <Hint>{t('jobsEmpty')}</Hint>)}
  </>
}

type Job = Settings['schedules']['jobs'][number]
type DraftJob = Omit<Job, 'timeoutMinutes'> & { timeoutMinutes: string }
function JobEditor({ job, expanded, onToggle, onChange, onRemove }: {
  job: DraftJob; expanded: boolean; onToggle: () => void; onChange: (job: DraftJob) => void; onRemove: () => void
}) {
  const { t } = usePanel()
  const name = job.name.trim() || t('newJob')
  const edit = (next: Partial<DraftJob>) => onChange({ ...job, ...next })
  return <li className="dt-rule">
    <DisclosureRow icon={<span className="dt-rule-dot" data-enabled={job.enabled || undefined} />} title={name} open={expanded}
      onToggle={onToggle} collapsedContent={<span className="dt-rule-preview dt-mono">{job.cron}</span>}>
      <div className="dt-rule-body">
        <Field label={t('jobName')}><Input value={job.name} required maxLength={LIMITS.ruleName}
          onChange={event => edit({ name: event.target.value })} /></Field>
        <div className="dt-grid3">
          <Field label={t('jobCron')} hint={t('jobCronHint')}><Input className="dt-mono" value={job.cron} required spellCheck={false}
            placeholder="0 9 * * 1-5" onChange={event => edit({ cron: event.target.value })} /></Field>
          <Field label={t('jobTimeZone')} hint={t('jobTimeZoneHint')}><Input value={job.timeZone} required spellCheck={false}
            placeholder="Asia/Shanghai" onChange={event => edit({ timeZone: event.target.value })} /></Field>
          <Field label={t('jobTimeout')}><Input type="number" required min={LIMITS.scheduleTimeoutMinutes.min}
            max={LIMITS.scheduleTimeoutMinutes.max} value={job.timeoutMinutes}
            onChange={event => edit({ timeoutMinutes: event.target.value })} /></Field>
        </div>
        <Field label={t('jobCommand')} hint={t('jobCommandHint')}>
          <textarea className="dt-textarea dt-mono" rows={4} required maxLength={LIMITS.scheduleCommand} spellCheck={false}
            value={job.command} onChange={event => edit({ command: event.target.value })} />
        </Field>
        <div className="dt-actions">
          <Button variant="ghost" size="sm" icon={<Icon name="trash" />} onClick={onRemove}>{t('remove')}</Button>
        </div>
      </div>
    </DisclosureRow>
    <Switch className="dt-rule-switch" checked={job.enabled} onChange={enabled => edit({ enabled })} label={t('jobEnable', { name })} />
  </li>
}

export function ScheduleSettings() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.schedules
  const saved = { jobs: block.value.jobs.map(job => ({ ...job, timeoutMinutes: String(job.timeoutMinutes) })) }
  const draft = useBlockDraft('schedules', saved, block.revision,
    value => ({ jobs: value.jobs.map(job => ({ ...job, timeoutMinutes: numberOf(job.timeoutMinutes) })) }))
  const { jobs } = draft.value
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (id: string) => { const next = new Set(expanded); if (next.has(id)) next.delete(id); else next.add(id); setExpanded(next) }
  const add = () => {
    const id = `job-${crypto.randomUUID().slice(0, 8)}`
    setExpanded(new Set([...expanded, id]))
    draft.edit({ jobs: [...jobs, { id, name: '', enabled: true, cron: '', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      command: '', timeoutMinutes: '30' }] })
  }
  return <div className="dt-form">
    <form className="dt-form dt-block" onSubmit={event => { void draft.submit(event) }}
      onInvalidCapture={() => setExpanded(new Set(jobs.map(job => job.id)))}>
      <Fields disabled={draft.busy}>
        <h2 className="dt-block-title">{t('scheduleBlock')}<InfoTip text={t('scheduleIntro')} /></h2>
        <Section title={t('jobs')} action={<Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={add}>{t('addJob')}</Button>}>
          {jobs.length ? <ul className="dt-rules">{jobs.map((job, index) => <JobEditor key={job.id} job={job} expanded={expanded.has(job.id)}
            onToggle={() => toggle(job.id)}
            onChange={next => draft.edit({ jobs: jobs.map((item, position) => position === index ? next : item) })}
            onRemove={() => draft.edit({ jobs: jobs.filter((_, position) => position !== index) })} />)}</ul>
            : <Hint>{t('jobsEmpty')}</Hint>}
        </Section>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['schedules']} />
  </div>
}
