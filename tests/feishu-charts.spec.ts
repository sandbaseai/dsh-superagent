/** Chart lines in a Feishu reply become image replies read from the ticket's directory. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { chartLines, sendFeishu } from '../src/sources/feishu-channel.ts'
import type { OutboundMessage } from '../src/core/index.ts'

let root: string
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'charts ')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const message = (text: string, kind: OutboundMessage['kind'] = 'reply'): OutboundMessage =>
  ({ id: 'reply-1', kind, text, channel: { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } } })
function host(directory?: string) {
  const calls: { args: string[]; cwd?: string }[] = []
  return { calls, host: { commands: { lark: async (args: string[], cwd?: string) => { calls.push({ args, ...cwd ? { cwd } : {} }); return {} } } as never,
    ...directory ? { directory } : {} } }
}

it('takes chart lines out of the text, at most three and each once', () => {
  expect(chartLines('**结论**: x\n[[chart:a.png]]\n\n\n[[chart:a.png]]\n  [[chart:b-2.png]]  \n[[chart:../c.png]]\n[[chart:d.png]] trailing'))
    .toEqual({ text: '**结论**: x\n\n[[chart:../c.png]]\n[[chart:d.png]] trailing', charts: ['a.png', 'b-2.png'] })
})

it('replies with the text, then each chart that is a PNG directly in the ticket directory', async () => {
  const dir = join(root, 'ticket')
  writeFileSync(join(root, 'outside.png'), PNG)
  mkdirSync(dir)
  writeFileSync(join(dir, 'good.png'), PNG)
  writeFileSync(join(dir, 'fake.png'), 'not a png')
  symlinkSync(join(root, 'outside.png'), join(dir, 'link.png'))
  const { calls, host: h } = host(dir)
  const result = await sendFeishu(h, message('**结论**: ok\n[[chart:good.png]]\n[[chart:fake.png]]\n[[chart:link.png]]\n[[chart:missing.png]]'))
  expect(result).toBe('sent')
  expect(calls.map(call => call.args)).toEqual([
    ['im', '+messages-reply', '--message-id', 'om_1', '--markdown', '**结论**: ok', '--reply-in-thread', '--idempotency-key', 'reply-1'],
    ['im', '+messages-reply', '--message-id', 'om_1', '--image', 'good.png', '--reply-in-thread', '--idempotency-key', 'reply-1-chart-0']])
  expect(calls[1]!.cwd).toBe(dir)
})

it('sends no image without a ticket directory, and leaves an acknowledgement as written', async () => {
  const { calls, host: h } = host()
  await sendFeishu(h, message('done\n[[chart:good.png]]'))
  expect(calls.map(call => call.args[5])).toEqual(['done'])
  const ack = host(root)
  await sendFeishu(ack.host, message('收到 [[chart:a.png]]', 'acknowledgement'))
  expect(ack.calls.map(call => call.args[5])).toEqual(['收到 [[chart:a.png]]'])
})
