/**
 * A synthetic Tencent Cloud CLS alarm and its recovery notice as Feishu chat-history items, built from the CLS notification
 * variables in https://cloud.tencent.com/document/product/614/74718; no real alarm message was captured.
 */
import type { HistoricalMessage } from '../../src/sources/feishu-trigger.ts'

/** The alert chat the CLS alarm bot posts in. */
export const ALERT_CHAT = 'oc_clsalerts'
/** The CLS alarm bot's sender id, as the history API reports an app's message. */
export const ALERT_BOT = 'cli_clsalarm'
const START = Date.parse('2026-11-11T07:20:00Z')
const lines = (notice: string, extra: string[]) => [
  `【腾讯云日志服务 CLS】${notice}`,
  '告警策略：app-apiserver 5xx 过多',
  '告警级别：Critical',
  '地域：新加坡（ap-singapore）',
  '日志主题：app-apiserver-prod（7c1e2f3a-0000-4000-8000-00000000c1a5）',
  '触发条件：status:>=500 | select count(*) as c，$1.c > 50',
  '开始时间：2026-11-11 15:20:00',
  ...extra,
  '详情链接：https://alarm.cls.tencentcs.com/AbCdEf12',
].join('\n')
const message = (id: string, at: number, text: string): HistoricalMessage => ({
  message_id: id, chat_id: ALERT_CHAT, create_time: String(at), msg_type: 'text',
  sender: { id: ALERT_BOT, id_type: 'app_id', sender_type: 'app' },
  body: { content: JSON.stringify({ text }) },
})
/** The alarm firing: notification type 1. */
export const clsAlert = message('om_clsalert1', START + 30_000,
  lines('告警通知', ['通知类型：告警', '持续时间：5 分钟', '触发参数：$1.c=137']))
/** The same alarm's recovery notice: notification type 2. */
export const clsRecovery = message('om_clsrecover1', START + 20 * 60_000,
  lines('告警恢复通知', ['通知类型：恢复', '持续时间：20 分钟']))
