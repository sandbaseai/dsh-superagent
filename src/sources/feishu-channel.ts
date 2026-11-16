/** Feishu outbound channel: posts threaded bot replies and constructs chat deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { realpathSync, statSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/** A chart line a worker puts in its reply: `[[chart:<name>.png]]`, naming a PNG it wrote in its ticket directory. */
const CHART = /^[ \t]*\[\[chart:([a-z0-9][a-z0-9-]{0,60}\.png)\]\][ \t]*$/gm
const MAX_CHART_BYTES = 5 * 1024 * 1024
const MAX_CHARTS = 3
/** The chart names of a reply and its text without them. */
export function chartLines(text: string): { text: string; charts: string[] } {
  const charts = [...text.matchAll(CHART)].map(match => match[1]!)
  return { text: text.replace(CHART, '').replace(/\n{3,}/g, '\n\n').trim(), charts: [...new Set(charts)].slice(0, MAX_CHARTS) }
}
/** Whether `name` is a PNG of at most 5 MiB directly inside `directory`, after following links. */
function chartFile(directory: string, name: string): boolean {
  try {
    const root = realpathSync(directory)
    const path = realpathSync(join(directory, name))
    if (!path.startsWith(root + sep) || path.slice(root.length + 1).includes(sep)) return false
    const size = statSync(path).size
    if (size === 0 || size > MAX_CHART_BYTES) return false
    return readFileSync(path).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  } catch { return false }
}
/**
 * Replies in the topic of the target message; Feishu keeps at most one reply per idempotency key (the outgoing message's
 * `message.id`). Chart lines become image replies in the same topic after the text, read from the ticket's directory;
 * a chart that is missing or not a PNG there is left out.
 */
export async function sendFeishu(host: Pick<SourceContext, 'commands'> & { directory?: string }, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const { text: body, charts } = message.kind === 'acknowledgement' ? { text: message.text, charts: [] } : chartLines(message.text)
  const text = checkedImText(body)
  const reply = ['im', '+messages-reply', '--message-id', messageId, '--markdown', text, '--reply-in-thread', '--idempotency-key', message.id]
  try {
    await host.commands.lark(reply)
    const directory = host.directory
    for (const [index, name] of charts.entries()) {
      if (!directory || !chartFile(directory, name)) continue
      await host.commands.lark(['im', '+messages-reply', '--message-id', messageId, '--image', name, '--reply-in-thread',
        '--idempotency-key', `${message.id.slice(0, 40)}-chart-${index}`], directory)
    }
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
