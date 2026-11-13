/**
 * Recognizes alert notices that monitoring bots post to Feishu chats: Tencent Cloud Observability cards (Prometheus, Cloud
 * Monitor, CLS), the CLS text notice, and a site fallback-page notice (`【<site> 兜底页告警】`). A parsed alert keys one policy and object, so
 * its repeated firings and its recovery share an alert Thread.
 */
import { createHash } from 'node:crypto'

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
    return build('cls', { status: notice.includes('恢复') ? 'recovered' : 'firing' }, field(lines, '告警策略'), field(lines, '日志主题'))
  }
  return undefined
}
/** The id of a chat's alert Thread for `key`, under the Feishu Source. */
export const alertThreadId = (chatId: string, key: string): string => `${chatId}:alert:${key}`
export const isAlertThread = (id: string): boolean => id.includes(':alert:')
