// What each worker and its subagents did lately.
import { expect, it } from 'vitest'
import { Activities, type ActivityEvent } from '../src/executor/activity.ts'

const call = (time: number, name: string, args: object): ActivityEvent => ({ type: 'tool/call', time, data: { name, arguments: JSON.stringify(args) } })
const result = (time: number, isError = false): ActivityEvent => ({ type: 'tool/result', time, data: { message: { isError } } })
const answer = (time: number, input: number, output: number): ActivityEvent => ({ type: 'assistant/message', time,
  data: { usage: { inputTokens: input, outputTokens: output } } })

it('keeps the last tool with the start of its command, the tool calls, failures and tokens, and when anything last happened', () => {
  const activities = new Activities()
  activities.record('t1', answer(1000, 100, 20))
  activities.record('t1', call(2000, 'bash', { command: `dsh-oncall cls --topic api ${'x'.repeat(100)}\nsecond line` }))
  activities.record('t1', result(3000, true))
  activities.record('t1', call(4000, 'read', { path: 'src/app.ts' }))
  // An event the record does not read changes nothing.
  activities.record('t1', { type: 'turn/end', time: 9000 })
  const activity = activities.get('t1')!
  expect(activity).toMatchObject({ tools: 2, errors: 1, tokens: 120, subagents: 0, lastAt: new Date(4000).toISOString(),
    lastTool: { name: 'read', detail: 'src/app.ts' } })
  activities.record('t1', call(5000, 'bash', { command: `dsh-oncall cls --topic api ${'x'.repeat(100)}` }))
  expect(activities.get('t1')!.lastTool!.detail).toHaveLength(80)
  expect(activities.get('t1')!.lastTool!.detail!.endsWith('…')).toBe(true)
  // Arguments that are not JSON leave the tool without a detail.
  activities.record('t1', { type: 'tool/call', time: 6000, data: { name: 'bash', arguments: '{' } })
  expect(activities.get('t1')!.lastTool).toEqual({ name: 'bash', at: new Date(6000).toISOString() })
})

it('counts the subagents whose turn runs, reads a worker\'s Session once in place of what it saw, and forgets ended tickets', () => {
  const activities = new Activities()
  activities.subagent('t1', 's1', true); activities.subagent('t1', 's2', true); activities.subagent('t1', 's1', false)
  activities.record('t1', call(1000, 'bash', { command: 'ls' }))
  let reads = 0
  const session = () => { reads++; return [answer(500, 10, 5), call(1000, 'bash', { command: 'ls' })] }
  activities.seed('t1', session)
  activities.seed('t1', session)
  expect(reads).toBe(1)
  expect(activities.get('t1')).toMatchObject({ tools: 1, tokens: 15, subagents: 1 })
  activities.keep(new Set())
  expect(activities.get('t1')).toBeUndefined()
  activities.seed('t1', session)
  expect(reads).toBe(2)
})
