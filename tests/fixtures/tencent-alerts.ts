/**
 * Tencent Cloud Observability alert cards and Example fallback-page notices as Feishu chat-history items, sanitized from
 * messages captured in the real alert chat on 2026-11-11: account ids, instance ids, IPs, user agents, links and message ids
 * are replaced; the card layout, labels and status words are kept.
 */
import type { HistoricalMessage } from '../../src/sources/feishu-trigger.ts'

/** The alert chat the Tencent Cloud alert bot posts in. */
export const ALERT_CHAT = 'oc_alertchat0001'
/** The alert bot's sender id, as the history API reports an app's message. */
export const ALERT_BOT = 'cli_alertbot0001'
const START = Date.parse('2026-11-11T14:06:46Z')
const ACCOUNT = '您好！您账号（账号ID: 100000000000，昵称: 100000000000）的'
const GRAFANA = 'https://grafana.example.tencent-cloud.com/d/provider-health?orgId=1&var-provider=provider-a'
const link = (href: string, text = href) => ({ tag: 'a', href, text })
const text = (value: string) => ({ tag: 'text', text: value })
const card = (id: string, at: number, title: string, row: object[]): HistoricalMessage => ({
  message_id: id, chat_id: ALERT_CHAT, create_time: String(at), msg_type: 'interactive',
  sender: { id: ALERT_BOT, id_type: 'app_id', sender_type: 'app' },
  body: { content: JSON.stringify({ title, elements: [row] }) },
})
const FIRING = '🟥腾讯云可观测平台告警'
const RECOVERED = '🟩腾讯云可观测平台告警'
const prometheus = (status: string, content: string, object: string, policy: string, time: string, grafana = GRAFANA) => [
  text(`${ACCOUNT}Prometheus告警`), text(status), text(`\n告警内容: ${content} 大盘：`), link(grafana),
  text(`\n告警对象: ${object}\n告警策略: ${policy}\n时间：${time}\n您可以登录`), link('https://mc.tencent.com/xxxx', '腾讯云可观测平台'),
  text('查看'),
]
const QPS = '供应商 provider-a QPS 较 15 分钟前增长超过 3 倍，可能是其他供应商故障导致 Fallback 集中到此供应商。'

/** Prometheus ProviderQPSSpike firing. */
export const qpsFiring = card('om_qpsfiring', START + 30_000, FIRING, prometheus('已触发', QPS,
  '供应商 provider-a 流量突增（当前 30.10 req/s）', 'example_alerts_p2/ProviderQPSSpike', '触发时间: 2026-11-11 22:06:46 (UTC+08:00)'))
/** The same alarm still firing an hour later, with another measurement. */
export const qpsOngoing = card('om_qpsongoing', START + 60 * 60_000, FIRING, prometheus('持续触发', QPS,
  '供应商 provider-a 流量突增（当前 12.5 req/s）', 'example_alerts_p2/ProviderQPSSpike',
  '触发时间: 2026-11-11 22:06:46 (UTC+08:00)  持续时间: 1h0m0s'))
/** The same alarm's recovery. */
export const qpsRecovered = card('om_qpsrecovered', START + 70 * 60_000, RECOVERED, prometheus('已恢复', QPS,
  '供应商 provider-a 流量突增（当前 6.41 req/s）', 'example_alerts_p2/ProviderQPSSpike',
  '触发时间: 2026-11-11 22:06:46 (UTC+08:00) 恢复时间: 2026-11-11 23:16:46 (UTC+08:00)'))
const ttft = (id: string, at: number, model: string, value: string) => card(id, at, FIRING, prometheus('已触发',
  `模型 ${model} 流式请求首字返回时间（TTFT）P95 达到 ${value}，超过 45s 阈值持续 5 分钟。`,
  `模型 ${model} 流式首字 P95 延迟飙升 (${value})（${model}）`, 'example_alerts_p1/ModelStreamTTFTSpike',
  '触发时间: 2026-11-11 22:10:46 (UTC+08:00)', `https://grafana.example.tencent-cloud.com/d/model-health?var-model=${model}`))
/** ModelStreamTTFTSpike firing for two models. */
export const ttftOpus = ttft('om_ttftopus', START + 4 * 60_000, 'anthropic/claude-opus-5.5', '74.85s')
export const ttftSonnet = ttft('om_ttftsonnet', START + 4 * 60_000 + 1000, 'anthropic/claude-sonnet-5.5', '51s')

const mysql = (status: string, current: string, extra: string, more: object[]) => [
  text(`${ACCOUNT}云产品监控告警`), text(status),
  text(`。\n告警内容：云数据库-MySQL-主机监控 | 内存利用率 > 90%\n告警对象：cdb-test0001(实例名:db-main,IP地址:10.0.0.1:3306),实例类型:master\n`
    + `当前数据：${current} (内存利用率)\n项目|地域：默认项目 | 弗吉尼亚\n告警策略：MySQL-master-ro\n触发时间：2026-11-11 10:48:00 (UTC+08:00)\n${extra}`),
  ...more,
  link('https://console.cloud.tencent.com/monitor/alarm/history', '腾讯云可观测平台'), text('查看告警详情，或在'),
  link('https://mc.tencent.com/yyyy', '腾讯云助手小程序'), text('查看告警详情。'),
]
/** Cloud Monitor MySQL memory alarm still firing. */
export const mysqlOngoing = card('om_mysqlongoing', START + 2 * 60_000, FIRING, mysql('持续触发', '91.4%', '',
  [link('https://h5.monitor.cloud.tencent.com/zzzz', '快捷屏蔽'), text('\n持续时长：11小时0分钟\n您可以登录')]))
/** The same Cloud Monitor alarm's recovery. */
export const mysqlRecovered = card('om_mysqlrecovered', START + 3 * 60_000, RECOVERED, mysql('恢复', '76.67%',
  '持续时长：11小时21分钟\n恢复时间：2026-11-11 22:09:00 (UTC+08:00)\n您可以登录', []))

const fallback = (id: string, at: number, lines: string[]): HistoricalMessage => ({
  message_id: id, chat_id: ALERT_CHAT, create_time: String(at), msg_type: 'text',
  sender: { id: ALERT_BOT, id_type: 'app_id', sender_type: 'app' },
  body: { content: JSON.stringify({ text: ['【Example 兜底页告警】', ...lines].join('\n') }) },
})
/** A Example fallback-page 404 notice. */
export const fallback404 = fallback('om_fallback404', START + 5 * 60_000, ['类型：404 页面不存在',
  '页面：https://www.example.com/models/example?ref=x', '来源：直接访问', 'UA：Mozilla/5.0 (test)', 'IP：203.0.113.7', '时间：2026-11-11 22:11:46'])
/** A Example fallback-page script error notice. */
export const fallbackError = fallback('om_fallbackerror', START + 6 * 60_000, ['类型：页面错误',
  '页面：https://www.example.com/models/example', '来源：https://www.example.com/',
  "错误：Failed to execute 'insertBefore' on 'Node'", 'UA：Mozilla/5.0 (test)', 'IP：203.0.113.7', '时间：2026-11-11 22:12:46'])
