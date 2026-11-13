/** Tests for the Feishu alert parser and the alert Thread a bot's alert notice joins. */
import { describe, expect, it } from 'vitest'
import { feishuTrigger, historyEvent, parseAlert, type FeishuAlert } from '../src/sources/feishu.ts'
import { historyText, type HistoricalMessage } from '../src/sources/feishu-trigger.ts'
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
