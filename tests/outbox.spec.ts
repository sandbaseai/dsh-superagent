/** Outbox delivery when processing is paused or a Source kind registers late. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { IM_WORDS } from '../src/infra/text.ts'
import type { Store } from '../src/app/store.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('refuses a Feishu notice over the IM limit', () => {
  const long = Array.from({ length: IM_WORDS + 1 }, (_, i) => `w${i}`).join(' ')
  expect(() => h.runtime.outbox.send({ id: 'refused', channel: feishu('1', 'x').channel!, text: long, kind: 'notice' })).toThrow(`maximum is ${IM_WORDS}`)
  expect(h.runtime.outbox.status('refused')).toBeUndefined()
})

it('drops on start a Feishu message over the IM limit that an earlier version queued, and sends the one behind it', async () => {
  const channel = feishu('1', 'x').channel!
  const long = Array.from({ length: IM_WORDS + 1 }, (_, i) => `w${i}`).join(' ')
  const queue = (store: Store, id: string, text: string, attempts: number) => {
    store.receipts.add({ id, channel, text, kind: 'notice', ticketId: 't1' })
    store.db.prepare("INSERT INTO effect (kind, key, value, seq, due, since, attempts, error) VALUES ('reply', ?, '{}', ?, 0, ?, ?, 'Error: IM message has 101 words')")
      .run(id, attempts + 1, new Date().toISOString(), attempts)
  }
  await h.stop()
  h = await startRuntime(store => { queue(store, 'stale', long, 40); queue(store, 'next', '已合并。', 0) })
  expect([h.runtime.store.receipts.get('stale')?.dropped?.reason, h.runtime.health.reply?.state]).toEqual(['tooLong', 'ready'])
  await h.runtime.pump(); await h.runtime.sendReplies()
  // The Feishu Source may still be starting at the first attempt, which tries again after 5 seconds.
  await at(5000)
  expect([h.runtime.store.receipts.get('stale')?.dropped?.reason, h.runtime.outbox.status('next')]).toEqual(['tooLong', 'sent'])
  expect(JSON.stringify(vi.mocked(Commands.prototype.lark).mock.calls)).not.toContain('w100')
  expect(h.runtime.health.reply?.state).toBe('ready')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})
