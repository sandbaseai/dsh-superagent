/** Tests for the Feishu alert parser and the alert Thread a bot's alert notice joins. */
import { describe, expect, it } from 'vitest'
import { feishuTrigger, historyEvent, parseAlert, type FeishuAlert } from '../src/sources/feishu.ts'
import { historyText, type HistoricalMessage } from '../src/sources/feishu-trigger.ts'
import { looksLikeAlert, sameRuleTickets, screenAlert } from '../src/sources/feishu-alert.ts'
import { countAlert, UNPARSED_ALERTS } from '../src/sources/feishu-loops.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import type { Ticket } from '../src/core/index.ts'
import { clsAlert, clsRecovery } from './fixtures/cls-alert.ts'
import { ALERT_CHAT, fallback404, fallbackError, mysqlOngoing, mysqlRecovered, qpsFiring, qpsOngoing, qpsRecovered, ttftOpus,
  ttftSonnet } from './fixtures/tencent-alerts.ts'

const alert = (message: HistoricalMessage): FeishuAlert | undefined => parseAlert(historyText(message))
const trigger = (message: HistoricalMessage) => feishuTrigger(historyEvent(message, message.chat_id, false), 'ou_bot', 'cli_bot')!

describe('historyText', () => {
  it('renders a card as its title and rows of text and links', () => {
    const text = historyText(qpsFiring)
    expect(text).toMatch(/^🟥腾讯云可观测平台告警\n您好！您账号（账号ID: 100000000000，昵称: 100000000000）的Prometheus告警已触发\n告警内容: /)
    expect(text).toContain('大盘：https://grafana.example.tencent-cloud.com/d/provider-health?orgId=1&var-provider=provider-a\n告警对象: ')
    expect(text).toContain('告警策略: example_alerts_p2/ProviderQPSSpike\n')
    expect(text).toContain('您可以登录腾讯云可观测平台(https://mc.tencent.com/xxxx)查看')
    expect(text).not.toContain('"tag"')
  })
  it('keeps plain text and other JSON unchanged', () => {
    const message = (content: string): HistoricalMessage => ({ message_id: 'om_1', chat_id: 'oc_1', create_time: '1',
      sender: { id: 'ou_1', sender_type: 'user' }, body: { content } })
    expect(historyText(message('{"text":"hi"}'))).toBe('hi')
    expect(historyText(message('plain'))).toBe('plain')
    expect(historyText(message('{"image_key":"img_1"}'))).toBe('{"image_key":"img_1"}')
    expect(historyText(message(JSON.stringify({ title: 'T', content: [[{ tag: 'text', text: 'a ' }, { tag: 'at', user_name: 'Li' },
      { tag: 'img', image_key: 'x' }]] })))).toBe('T\na @Li')
  })
})

describe('parseAlert', () => {
  it.each([
    [qpsFiring, { kind: 'prometheus', status: 'firing', policy: 'example_alerts_p2/ProviderQPSSpike', object: '供应商 provider-a 流量突增' }],
    [qpsOngoing, { kind: 'prometheus', status: 'firing', ongoing: true, policy: 'example_alerts_p2/ProviderQPSSpike' }],
    [qpsRecovered, { kind: 'prometheus', status: 'recovered', policy: 'example_alerts_p2/ProviderQPSSpike' }],
    [ttftOpus, { kind: 'prometheus', status: 'firing', policy: 'example_alerts_p1/ModelStreamTTFTSpike' }],
    [mysqlOngoing, { kind: 'cloud-monitor', status: 'firing', ongoing: true, policy: 'MySQL-master-ro', object: 'cdb-test0001' }],
    [mysqlRecovered, { kind: 'cloud-monitor', status: 'recovered', policy: 'MySQL-master-ro', object: 'cdb-test0001' }],
    [fallback404, { kind: 'fallback-page', status: 'firing', policy: '404 页面不存在', object: 'https://www.example.com/models/example' }],
    [fallbackError, { kind: 'fallback-page', status: 'firing', policy: '页面错误', object: 'https://www.example.com/models/example' }],
    [clsAlert, { kind: 'cls', status: 'firing', policy: 'app-apiserver 5xx 过多' }],
    [clsRecovery, { kind: 'cls', status: 'recovered', policy: 'app-apiserver 5xx 过多' }],
  ] as const)('parses %#', (message, expected) => {
    expect(alert(message)).toMatchObject(expected)
    expect(alert(message)?.key).toMatch(/^[0-9a-f]{16}$/)
  })
  it('keys firing, still firing and recovery of one policy and object alike', () => {
    expect(new Set([qpsFiring, qpsOngoing, qpsRecovered].map(message => alert(message)!.key)).size).toBe(1)
    expect(alert(mysqlOngoing)!.key).toBe(alert(mysqlRecovered)!.key)
    expect(alert(clsAlert)!.key).toBe(alert(clsRecovery)!.key)
    expect(alert(ttftOpus)!.key).not.toBe(alert(ttftSonnet)!.key)
    expect(alert(ttftOpus)!.object).toContain('anthropic/claude-opus-5.5')
    expect(alert(ttftOpus)!.object).not.toContain('74.85')
  })
  it('keys CLS alarms on the region, so one policy and topic in two regions are two alarms', () => {
    const other = historyText(clsAlert).replace('地域：新加坡（ap-singapore）', '地域：弗吉尼亚（na-ashburn）')
    const otherRecovery = historyText(clsRecovery).replace('地域：新加坡（ap-singapore）', '地域：弗吉尼亚（na-ashburn）')
    expect(parseAlert(other)!.key).not.toBe(alert(clsAlert)!.key)
    expect(parseAlert(other)!.key).toBe(parseAlert(otherRecovery)!.key)
  })
  it('keys Cloud Monitor alarms on the instance and the alarm content', () => {
    const cpu = historyText(mysqlOngoing).replace('内存利用率 > 90%', 'CPU利用率 > 80%')
    expect(parseAlert(cpu)!.object).toBe('cdb-test0001')
    expect(parseAlert(cpu)!.key).not.toBe(alert(mysqlOngoing)!.key)
  })
  it('returns undefined for other bot text and incomplete alerts', () => {
    expect(parseAlert('构建完成：main 通过')).toBeUndefined()
    expect(parseAlert('🟥腾讯云可观测平台告警\n告警对象: x')).toBeUndefined()
    expect(parseAlert('【Example 兜底页告警】\n类型：404 页面不存在')).toBeUndefined()
  })
})

describe('an alert Trigger', () => {
  it('belongs to the alert Thread first and its message Thread second', () => {
    const result = trigger(qpsFiring)
    const parsed = alert(qpsFiring)!
    expect(result.threads).toEqual([{ source: 'feishu', id: `${ALERT_CHAT}:alert:${parsed.key}` },
      { source: 'feishu', id: `${ALERT_CHAT}:om_qpsfiring` }])
    expect(result.meta.alert).toEqual(parsed)
    expect(result.human).toBe(false)
    expect(result.channel!.address).toMatchObject({ chatId: ALERT_CHAT, messageId: 'om_qpsfiring' })
    expect(trigger(qpsOngoing).threads[0]).toEqual(result.threads[0])
  })
  it('leaves a human message that quotes an alert unchanged', () => {
    const human = { ...qpsFiring, message_id: 'om_human', sender: { id: 'ou_member', sender_type: 'user' } }
    const result = trigger(human)
    expect(result.threads).toEqual([{ source: 'feishu', id: `${ALERT_CHAT}:om_human` }])
    expect(result.meta).not.toHaveProperty('alert')
  })
})

describe('screenAlert', () => {
  const notice = (status: 'firing' | 'recovered') => ({ ...trigger(qpsFiring), meta: { alert: { status } } })
  it('sets aside a recovery, and a repeat while a ticket on its Thread is live, and nothing else', () => {
    expect(screenAlert(notice('recovered'), [])).toBe('alert_recovered')
    expect(screenAlert(notice('firing'), [{ id: 'live' } as Ticket])).toBe('alert_repeat')
    expect(screenAlert(notice('firing'), [{ id: 'done', ended: { at: '', by: 'executor', reason: 'x', outcome: 'completed' } } as Ticket]))
      .toBeUndefined()
    expect(screenAlert({ ...notice('firing'), meta: {} }, [{ id: 'live' } as Ticket])).toBeUndefined()
  })
})

describe('sameRuleTickets', () => {
  const at = '2026-11-25T12:00:00.000Z'
  const firing = { ...trigger(qpsFiring), at, meta: { alert: { status: 'firing', policy: 'p1/LatencyHigh', key: 'k1' } } }
  const started = (id: string, policy: string, hoursAgo: number) => ({ id, createdAt: new Date(Date.parse(at) - hoursAgo * 3600_000).toISOString(),
    mandate: { basis: { scope: { alert: { policy } } } } }) as unknown as Ticket
  it('names the tickets the firing alarm\'s rule started within the window, newest first, and none for a recovery or a zero window', () => {
    const tickets = [started('old', 'p1/LatencyHigh', 80), started('a', 'p1/LatencyHigh', 50), started('b', 'p1/LatencyHigh', 2),
      started('other', 'p1/Other', 1), started('later', 'p1/LatencyHigh', -1), { id: 'person', createdAt: at, mandate: { basis: {} } } as unknown as Ticket]
    expect(sameRuleTickets(firing, tickets, 72).map(ticket => ticket.id)).toEqual(['b', 'a'])
    expect(sameRuleTickets(firing, tickets, 0)).toEqual([])
    expect(sameRuleTickets({ ...firing, meta: { alert: { status: 'recovered', policy: 'p1/LatencyHigh' } } }, tickets, 72)).toEqual([])
    expect(sameRuleTickets({ ...firing, meta: {} }, tickets, 72)).toEqual([])
  })
})

describe('countAlert', () => {
  const context = () => { const reports: [string, Health][] = []; return { reports, ctx: { report: (entry: string, health: Health) => reports.push([entry, health]) } as unknown as SourceContext } }
  const changed = { ...trigger(qpsFiring), meta: {}, text: '🟥腾讯云可观测平台告警\n新格式\n告警名称: X' }
  it('reports an error after three alert-shaped bot messages in a row that did not parse, and clears it on the next parsed one', () => {
    expect(looksLikeAlert(changed.text)).toBe(true)
    const { reports, ctx } = context()
    for (let i = 1; i < UNPARSED_ALERTS; i++) countAlert(ctx, changed)
    expect(reports).toEqual([])
    countAlert(ctx, changed)
    expect(reports).toEqual([['alerts', expect.objectContaining({ state: 'error', code: 'alertsUnparsed', values: { count: '3', text: '🟥腾讯云可观测平台告警' } })]])
    countAlert(ctx, trigger(qpsFiring))
    expect(reports.at(-1)).toEqual(['alerts', expect.objectContaining({ state: 'ready', code: 'alertsParsed' })])
  })
  it('ignores people and bot messages that do not look like alerts', () => {
    const { reports, ctx } = context()
    for (let i = 0; i < 5; i++) {
      countAlert(ctx, { ...changed, human: true })
      countAlert(ctx, { ...changed, text: '日报：今天一切正常' })
    }
    expect(reports).toEqual([])
    expect(looksLikeAlert('日报：今天一切正常')).toBe(false)
  })
})
