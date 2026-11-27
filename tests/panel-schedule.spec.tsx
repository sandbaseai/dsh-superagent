// @vitest-environment jsdom
// The Schedule status and the scheduled jobs settings.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { SettingsSchema } from '../src/policy.ts'
import { usePanel, mount, all, find, click, type, text, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const BRIEF = { id: 'brief', name: '告警摘要', enabled: true, cron: '5 12-21/3 * * *', timeZone: 'Asia/Shanghai',
  command: 'oncall-ticket-digest --brief', timeoutMinutes: 30 }

it('lists each job with its schedule, next run and last outcome, shows a run\'s output, and runs a job by hand after confirming', async () => {
  server.settings = SettingsSchema.parse({ ...server.settings, schedules: { jobs: [BRIEF] } })
  server.runs.brief = [{ id: 'r1', reason: 'schedule', slot: '2026-11-26T13:05:00Z', startedAt: '2026-11-26T13:05:00Z',
    endedAt: '2026-11-26T13:05:42Z', outcome: 'failed', exitCode: 1, stderr: 'the gateway answered 429' }]
  await mount()
  await click(zh['tab.schedule'])
  expect(all('.dt-row-name').map(name => name.textContent)).toEqual(['告警摘要'])
  expect(text()).toContain('5 12-21/3 * * *')
  expect(text()).toContain(`${zh.jobLast} ${zh['runOutcome.failed']}`)
  await click(zh.jobRuns)
  expect(document.querySelector('.dt-pre')?.textContent).toBe('the gateway answered 429')
  expect(text()).toContain(zh.runSeconds.replace('{seconds}', '42'))
  await click(zh.jobRunNow)
  expect(text()).toContain(zh.jobRunNowConfirm.replace('{name}', '告警摘要'))
  await click(find(zh.confirm, '.dt-modal button, [role="dialog"] button'))
  expect(server.requests.some(request => request.method === 'POST' && request.path === 'schedules/brief/run')).toBe(true)
  expect(all('.dt-status-text').map(item => item.textContent)).toContain(zh.jobRunning)
})

it('adds, edits and saves scheduled jobs in their settings group', async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(zh['settingsGroup.schedule'])
  expect(text()).toContain(zh.jobsEmpty)
  await click(zh.addJob)
  await type(field<HTMLInputElement>(zh.jobName), '工单日报')
  await type(field<HTMLInputElement>(zh.jobCron), '17 9 * * *')
  await type(field<HTMLInputElement>(zh.jobTimeZone), 'Asia/Shanghai')
  await type(field<HTMLTextAreaElement>(zh.jobCommand), 'oncall-ticket-digest --hours 24')
  await click(zh.save)
  expect(server.settings.schedules.jobs).toMatchObject([{ name: '工单日报', cron: '17 9 * * *', timeZone: 'Asia/Shanghai',
    command: 'oncall-ticket-digest --hours 24', timeoutMinutes: 30, enabled: true }])
  expect(server.revisions.schedules).toBe(1)
})
