/**
 * Repeat notices: a firing alarm that a ticket on its alert Thread already analysed gets a short reply instead of silence,
 * naming the earlier conclusion and linking the analysis, at most once per `repeatNoticeMinutes` on the Thread. Every such
 * alarm, answered or not, also gets a ✅ reaction, so each card in the chat shows it was handled.
 */
import { key, latestReport, threadKey, type Ticket, type Trigger } from '../core/index.ts'
import { covers, isAlertThread, type FeishuAlert } from './feishu-alert.ts'
import { readFeishuLink } from './feishu-read.ts'
import { feishuRef, SOURCE } from './feishu-trigger.ts'
import type { SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import type { FeishuConfig } from './feishu.ts'
import { IM_WORDS, wordCount, wordPrefix } from '../infra/text.ts'

const CONCLUSION_CHARS = 160
/** Feishu's ✅ emoji, put on a repeat that the earlier analysis covers. */
const HANDLED = 'DONE'

/** The text of the `结论` (or `Conclusion`) part of a report's reply, up to the next bold label, cut to CONCLUSION_CHARS. */
export function conclusionOf(summary: string): string | undefined {
  const match = /\*\*(?:结论|Conclusion)\*\*\s*[:：]?\s*([\s\S]*?)(?=\n\s*\*\*[^*\n]+\*\*|$)/.exec(summary)
  const text = match?.[1]?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length <= CONCLUSION_CHARS ? text : `${text.slice(0, CONCLUSION_CHARS)}…`
}

/**
 * The ticket on the alarm's Thread that finished analysing it last, among those `covers` accepts: the same test
 * `screenAlert` sets the repeat aside by, so every repeat it skips is marked.
 */
export function analysedBy(ctx: Pick<SourceContext, 'threads' | 'tickets'>, trigger: Trigger, windowMs: number): Ticket | undefined {
  const ref = trigger.threads.find(thread => thread.source === SOURCE && isAlertThread(thread.id))
  const thread = ref && ctx.threads.get(threadKey(ref))
  if (!thread) return undefined
  return thread.subscriptions.flatMap(id => { const ticket = ctx.tickets.get(id); return ticket ? [ticket] : [] })
    .filter(ticket => covers(ticket, trigger, windowMs))
    .sort((a, b) => b.ended!.at.localeCompare(a.ended!.at))[0]
}

const clock = (at: string, brand: 'feishu' | 'lark') => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false,
  timeZone: brand === 'lark' ? 'UTC' : 'Asia/Shanghai' }).format(new Date(at))

/** Queues the repeat notice for a newly stored firing alarm, when the Source enables it and the alarm's Thread has an analysis. */
export async function repeatNotice(ctx: SourceContext, trigger: Trigger, config: FeishuConfig, signal?: AbortSignal): Promise<void> {
  const alert = trigger.meta.alert as FeishuAlert | undefined
  if (!config.repeatNoticeMinutes || alert?.status !== 'firing' || !trigger.channel) return
  const earlier = analysedBy(ctx, trigger, config.repeatWindowHours * 3600_000)
  if (!earlier) return
  const own = feishuRef(trigger)
  // Best effort: a missing reaction only leaves the card as it was.
  if (own) await ctx.commands.withSignal(signal).lark(['api', 'POST', `/open-apis/im/v1/messages/${own.messageId}/reactions`,
    '--data', JSON.stringify({ reaction_type: { emoji_type: HANDLED } })]).catch(() => undefined)
  const ref = trigger.threads.find(thread => isAlertThread(thread.id))!
  const sentKey = KV.feishu.repeatNotice(threadKey(ref))
  const last = ctx.state.get(sentKey)
  if (last && Date.parse(trigger.at) - Date.parse(last) < config.repeatNoticeMinutes * 60_000) return
  const brand = ctx.deployment.feishu?.brand ?? 'feishu'
  const origin = ctx.triggers.get(earlier.origin.triggerId)
  const source = origin && feishuRef(origin)
  // The link opens the earlier alarm's topic, where its analysis was posted; without it the notice names the time alone.
  const link = source ? await readFeishuLink(ctx.commands.withSignal(signal), source).catch(() => undefined) : undefined
  const conclusion = conclusionOf(latestReport(earlier)?.summary ?? '')
  const time = clock(earlier.ended!.at, brand)
  const lines = (conclusion: string | undefined) => (brand === 'lark'
    ? [`Same alarm as the one analysed at ${time} UTC; it is not investigated again within ${config.repeatWindowHours} h.`,
      ...conclusion ? [`**Earlier conclusion**: ${conclusion}`] : [], ...link ? [`[Full analysis](${link})`] : []]
    : [`同一告警 ${time} 已分析过，${config.repeatWindowHours} 小时内不再重复排查。`,
      ...conclusion ? [`**上次结论**: ${conclusion}`] : [], ...link ? [`[查看完整分析](${link})`] : []]).join('\n')
  // The link URL counts toward the IM limit, so the conclusion gets the words the rest of the notice leaves.
  const room = IM_WORDS - (wordCount(lines('x')) - 1)
  const text = lines(conclusion && room > 0 ? wordPrefix(conclusion, room) : undefined)
  ctx.notify({ id: key('repeat-notice', trigger.id), channel: trigger.channel, text, kind: 'notice', ticketId: earlier.id })
  ctx.state.set(sentKey, trigger.at)
}
