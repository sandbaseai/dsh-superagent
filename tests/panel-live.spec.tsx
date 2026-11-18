// @vitest-environment jsdom
// The live view.
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, tab, click, text, at } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import type { Activity } from '../src/executor/activity.ts'

usePanel()
it('joins the Sources, the Router and the worker slots, each lit by what it does, and says the state in one sentence', async () => {
  at({ page: 'live' })
  await mount()
  expect(tab(zh['tab.live']).getAttribute('aria-selected')).toBe('true')
  expect(all('.dt-live-card').map(card => card.getAttribute('data-state'))).toEqual(['run', 'run'])
  expect(all('.dt-live-link').every(link => link.getAttribute('data-flowing') === 'true')).toBe(true)
  // Two slots taken of three: one worker in its turn, one with only background work, and one free.
  expect(all('.dt-live-slot').map(slot => slot.getAttribute('data-state'))).toEqual(['turn', 'background', 'free'])
  expect(all('.dt-live-slot-state').map(item => item.textContent)).toEqual(['运行中 · 11 分钟', '后台任务中 · 2 个后台命令 · 11 分钟'])
  expect(text()).toContain('到达 12 · 过滤 2')
  expect(text()).toContain('2 / 3 工位')
  expect(document.querySelector('.dt-live-headline p')?.textContent)
    .toBe('Router 正在评估 1 个话题，2 个 Worker 在干活，1 个工单排队等工位，1 个工单等人处理。')
  await click('跑压测')
  expect(server.requests.some(request => request.path === 'tickets/t2')).toBe(true)
})

it('shows what each worker did last, with its subagents, tool calls and tokens, and marks a turn quiet for five minutes', async () => {
  at({ page: 'live' })
  await mount()
  expect(document.querySelector('.dt-live-activity')?.textContent)
    .toBe('bashdsh-oncall cls --topic api20 秒前有动作1 个 Subagent 在跑14 次工具调用 · 1 次出错182k tokens')
  expect(document.querySelector('.dt-live-slot[data-quiet]')).toBeNull()
  const [first, ...rest] = server.live.tickets
  const activity = { ...(first as unknown as { activity: Activity }).activity, lastAt: '2026-09-22T00:05:00Z' }
  server.live = { ...server.live, tickets: [{ ...first!, activity }, ...rest] }
  await remount()
  expect(document.querySelector('.dt-live-slot[data-quiet="true"]')).not.toBeNull()
  expect(text()).toContain('7 分钟没有动作')
})

it('opens the Router\'s main Session and each worker\'s Session from its card', async () => {
  at({ page: 'live' })
  await mount()
  await click(zh.liveOpenRouter)
  await click(all('.dt-live-slot button').filter(button => button.textContent === zh.liveOpenWorker)[1]!)
  expect(server.opened).toEqual(['master', 'worker-t2'])
  // A free slot has no Session to open.
  expect(all('.dt-live-slot[data-state="free"] button')).toEqual([])
})

it('traces the latest Ticket from its Trigger through the Decision to the worker, with where the time went', async () => {
  at({ page: 'live' })
  await mount()
  const steps = all('.dt-live-step').map(step => step.textContent)
  expect(steps[0]).toContain('飞书 上 ')
  expect(steps[0]).toContain('@bot 登录页又白屏了')
  expect(steps[1]).toContain('Router 判定接单（明确）：明确要求修复 · 用时 30 秒')
  expect(steps[2]).toBe('开工单「修复回归」 · 30 秒 后 Worker 开工')
  expect(steps[3]).toContain('Worker 最近报告进展：已复现，正在查 CLS 日志')
  expect(all('.dt-live-legend > span').map(item => item.textContent)).toEqual(['评估 30 秒', '等工位 30 秒', '执行 11 分钟'])
  await click(zh.liveOpenTicket)
  expect(server.requests.some(request => request.path === 'tickets/t1')).toBe(true)
})

it('turns the Router red when Evals fail and says when processing is paused', async () => {
  server.live = { ...server.live, router: { ...server.live.router, overdue: 1, unavailable: 1 },
    executor: { ...server.live.executor, paused: true }, problems: 4 }
  at({ page: 'live' })
  await mount()
  expect(all('.dt-live-card').map(card => card.getAttribute('data-state'))).toEqual(['run', 'error'])
  expect(text()).toContain(zh.livePaused)
  await click('2 个评估异常 ›')
  expect(tab(zh['tab.overview']).getAttribute('aria-selected')).toBe('true')
})

it('says when nothing is open, and shows the view in English', async () => {
  server.live = { ...server.live, tickets: [], total: 0, trace: undefined, executor: { ...server.live.executor, running: 0, queued: 0,
    person: 0 }, router: { ...server.live.router, busy: false, evaluating: [] } }
  at({ page: 'live' })
  await mount(en)
  expect(text()).toContain(en.liveNone)
  expect(document.querySelector('.dt-live-headline p')?.textContent).toBe('The Router is idle, no worker is at work.')
  expect(all('.dt-live-slot').map(slot => slot.getAttribute('data-state'))).toEqual(['free', 'free', 'free'])
  expect(all('.dt-live-link').some(link => link.getAttribute('data-flowing') === 'true')).toBe(true)
})
