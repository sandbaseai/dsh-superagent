/**
 * Recognizes alert notices that monitoring bots post to Feishu chats: Tencent Cloud Observability cards (Prometheus, Cloud
 * Monitor, CLS), the CLS text notice, and a site fallback-page notice (`【<site> 兜底页告警】`). A parsed alert keys one policy and object, so
 * its repeated firings and its recovery share an alert Thread.
 */
import { createHash } from 'node:crypto'
import { liveTicket, type Ticket, type Trigger } from '../core/index.ts'

export interface FeishuAlert {
  kind: 'prometheus' | 'cloud-monitor' | 'cls' | 'fallback-page' | 'tencent'
  status: 'firing' | 'recovered'
  /** A periodic repeat of an alarm that is still firing (`持续触发`). */
  ongoing?: true
  policy: string
  object: string
  /** First 16 hex digits of a sha256 over kind, policy, normalized object and, for Cloud Monitor, the alarm content. */
  key: string
}

const TENCENT = '腾讯云可观测平台告警'
/** A fallback-page notice's title: `【兜底页告警】`, optionally with the site's name before 兜底页告警. */
const FALLBACK = /^【[^】]*兜底页告警】/
/** A parenthesized measurement such as `（当前 6.41 req/s）` or `(74.85s)`; stable parentheses such as a model name stay. */
const MEASUREMENT = /[（(]\s*(?:当前\s*)?[-+]?\d[\d.,]*\s*[A-Za-z/%]*\s*[）)]/g

/** Returns the value of the first line labelled `label` with `:` or `：`, trimmed; undefined when absent or empty. */
function field(lines: string[], label: string): string | undefined {
  for (const line of lines) {
    const match = new RegExp(`^\\s*${label}\\s*[:：]\\s*(.*)$`).exec(line)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return undefined
}
const hash = (...parts: string[]): string => createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 16)

function tencentKind(text: string): FeishuAlert['kind'] {
  const phrase = /的([^\n的]*?)告警/.exec(text)?.[1] ?? ''
  if (/Prometheus/i.test(phrase)) return 'prometheus'
  if (phrase.includes('云产品监控')) return 'cloud-monitor'
  if (phrase.includes('日志服务') || /CLS/i.test(phrase)) return 'cls'
  return 'tencent'
}
function tencentStatus(first: string, text: string): Pick<FeishuAlert, 'status' | 'ongoing'> {
  const head = text.split('\n').slice(1, 3).join('\n')
  if (/告警[ \t]*(?:已恢复|恢复)/.test(head)) return { status: 'recovered' }
  if (/告警[ \t]*持续触发/.test(head)) return { status: 'firing', ongoing: true }
  if (/告警[ \t]*已触发/.test(head)) return { status: 'firing' }
  return { status: first.includes('🟩') ? 'recovered' : 'firing' }
}
function build(kind: FeishuAlert['kind'], state: Pick<FeishuAlert, 'status' | 'ongoing'>, policy: string | undefined,
  object: string | undefined, extra = ''): FeishuAlert | undefined {
  if (!policy || !object) return undefined
  const normalized = kind === 'cloud-monitor' ? object.split(/[（(]/)[0]!.trim() : object.replace(MEASUREMENT, '').replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return { kind, ...state, policy, object: normalized, key: hash(kind, policy, normalized, extra) }
}

/** Parses an alert notice from a message's text, or returns undefined when the text is not a recognized alert. */
export function parseAlert(text: string): FeishuAlert | undefined {
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  if (first.includes(TENCENT)) {
    const kind = tencentKind(text)
    return build(kind, tencentStatus(first, text), field(lines, '告警策略'), field(lines, '告警对象'),
      kind === 'cloud-monitor' ? field(lines, '告警内容') ?? '' : '')
  }
  if (FALLBACK.test(first.trim())) {
    const page = field(lines, '页面')?.split(/[?#\s]/)[0]
    return build('fallback-page', { status: 'firing' }, field(lines, '类型'), page)
  }
  const notice = field(lines, '通知类型')
  if (notice !== undefined && field(lines, '告警策略')) {
    // One policy and topic name can exist in several regions, so the region keys the alarm too.
    return build('cls', { status: notice.includes('恢复') ? 'recovered' : 'firing' }, field(lines, '告警策略'), field(lines, '日志主题'),
      field(lines, '地域') ?? '')
  }
  return undefined
}
/**
 * Whether a message has the shape of a notice `parseAlert` reads (the Tencent title, a fallback-page title, or a `告警策略` or
 * `通知类型` line), so that failing to parse it means the monitoring bot's format changed.
 */
export function looksLikeAlert(text: string): boolean {
  const first = text.split('\n')[0] ?? ''
  return first.includes(TENCENT) || /兜底页告警/.test(first) || /^\s*(?:告警策略|通知类型)\s*[:：]/m.test(text)
}
/**
 * Whether `ticket`, started before `trigger`, finished without a person stopping it less than `windowMs` before it. The window
 * counts from the ticket's latest end, since a ticket resumed on its Thread analyses the alert again each time it runs.
 */
export function covers(ticket: Ticket, trigger: Trigger, windowMs: number): boolean {
  if (!ticket.ended || ticket.ended.by === 'human' || ticket.origin.triggerIds.includes(trigger.id)) return false
  const at = Date.parse(trigger.at)
  return at >= Date.parse(ticket.createdAt) && at - Date.parse(ticket.ended.at) < windowMs
}
/**
 * Sets a listed bot's alert aside before assessment: its recovery notice (`alert_recovered`), a repeat while a ticket on
 * its alert Thread is live (`alert_repeat`), and, when `windowHours` is set, a repeat of an alert a ticket on its Thread
 * finished analysing within that many hours (see `covers`), whose analysis covers it (`alert_analysed`).
 */
export function screenAlert(trigger: Trigger, tickets: Ticket[], windowHours = 0): string | undefined {
  const alert = trigger.meta.alert as Partial<FeishuAlert> | undefined
  if (typeof alert?.status !== 'string') return undefined
  if (alert.status === 'recovered') return 'alert_recovered'
  if (tickets.some(liveTicket)) return 'alert_repeat'
  if (!windowHours) return undefined
  return tickets.some(ticket => covers(ticket, trigger, windowHours * 3600_000)) ? 'alert_analysed' : undefined
}
/** The words of an alarm object that name what it is about, such as a provider or model, lowercased. */
const objectWords = (object: string | undefined): Set<string> =>
  new Set((object ?? '').toLowerCase().split(/[\s/·,，:：|()（）]+/).filter(word => word.length >= 3))

/**
 * Tickets among `tickets` that a firing alarm's rule started within `hours` before it, on any object of the rule: a known
 * cause the alarm may share. Those whose object shares more words with the alarm's, such as the same provider or model,
 * come first, and among them the newest.
 */
export function sameRuleTickets(trigger: Trigger, tickets: Ticket[], hours: number): Ticket[] {
  const alert = trigger.meta.alert as Partial<FeishuAlert> | undefined
  if (!hours || alert?.status !== 'firing' || !alert.policy) return []
  const at = Date.parse(trigger.at)
  const words = objectWords(alert.object)
  const started = (ticket: Ticket) => (ticket.mandate.basis.scope as { alert?: Partial<FeishuAlert> } | undefined)?.alert
  const shared = (ticket: Ticket) => [...objectWords(started(ticket)?.object)].filter(word => words.has(word)).length
  return tickets.filter(ticket => {
    const age = at - Date.parse(ticket.createdAt)
    return started(ticket)?.policy === alert.policy && age >= 0 && age < hours * 3600_000
  }).map(ticket => ({ ticket, shared: shared(ticket) }))
    .sort((a, b) => b.shared - a.shared || b.ticket.createdAt.localeCompare(a.ticket.createdAt)).map(item => item.ticket)
}
/** The id of a chat's alert Thread for `key`, under the Feishu Source. */
export const alertThreadId = (chatId: string, key: string): string => `${chatId}:alert:${key}`
export const isAlertThread = (id: string): boolean => id.includes(':alert:')
