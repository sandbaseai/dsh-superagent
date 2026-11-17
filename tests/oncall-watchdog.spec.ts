/** Tests for scripts/oncall-watchdog against a fake management API and a stub lark-cli. */
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'oncall-watchdog')
let root: string, api: Server, url: string
let calls: string[] = []
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
type Row = { id: string; title: string; stage: string; action?: string; createdAt: string; updatedAt: string; started?: string }
let tickets: Row[] = []

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'oncall watchdog '))
  calls = []
  tickets = [
    { id: 'quick000aaaa', title: '刚开始的告警', stage: 'working', createdAt: ago(3), updatedAt: ago(3), started: ago(3) },
    { id: 'slow0000bbbb', title: '慢的告警', stage: 'working', createdAt: ago(20), updatedAt: ago(1), started: ago(20) },
    { id: 'stuck000cccc', title: '卡住的告警', stage: 'working', createdAt: ago(40), updatedAt: ago(1), started: ago(35) },
    { id: 'queue000dddd', title: '排队的告警', stage: 'working', action: 'queued', createdAt: ago(16), updatedAt: ago(16) },
    { id: 'block000eeee', title: '卡在人的告警', stage: 'person', action: 'blocked', createdAt: ago(60), updatedAt: ago(20) },
    { id: 'revw0000ffff', title: '等审阅', stage: 'person', action: 'review', createdAt: ago(60), updatedAt: ago(50) },
  ]
  api = createServer((request, response) => {
    const path = request.url!.replace('/orchestrator/api/', '')
    calls.push(`${request.method} ${path}`)
    if (request.headers['x-orchestrator-request'] !== '1') { response.writeHead(403); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    const stop = /^tickets\/(\w+)\/stop$/.exec(path)
    if (stop) { tickets = tickets.filter(ticket => ticket.id !== stop[1]); response.end('{"stopped":true}'); return }
    const detail = /^tickets\/(\w+)$/.exec(path)
    if (detail) {
      const ticket = tickets.find(item => item.id === detail[1])!
      response.end(JSON.stringify({ assignments: [{ id: 'a0', state: 'ended', startedAt: ago(500) }, { id: 'a1', state: 'running', startedAt: ticket.started }] }))
      return
    }
    const state = new URL(`http://x/${path}`).searchParams.get('state')
    response.end(JSON.stringify({ items: tickets.filter(ticket => ticket.stage === state), next_offset: null }))
  })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  writeFileSync(join(root, 'lark'), `#!/bin/sh\ncat watchdog.md >> ${JSON.stringify(join(root, 'sent.md'))}; echo '---' >> ${JSON.stringify(join(root, 'sent.md'))}\n`, { mode: 0o755 })
})
afterEach(() => { api.close(); rmSync(root, { recursive: true, force: true }) })

function watch(...extra: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', [SCRIPT, '--url', url, '--chat', 'oc_ops', '--lark-cli', join(root, 'lark'),
    '--state', join(root, 'state.json'), ...extra], { timeout: 30_000 },
  (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const sent = () => existsSync(join(root, 'sent.md')) ? readFileSync(join(root, 'sent.md'), 'utf8').split('---\n').filter(Boolean) : []

it('posts each ticket past its limit once, stops the one past the stop limit, and leaves the rest alone', async () => {
  expect((await watch('--panel-url', 'https://panel.example/dsh')).code).toBe(0)
  expect(calls).toContain('POST tickets/stuck000cccc/stop')
  expect(calls.filter(call => call.startsWith('POST'))).toHaveLength(1)
  const [message] = sent()
  expect(message).toContain('**已停止** 卡住的告警：worker 跑了 35 分钟')
  expect(message).toContain('- 慢的告警：worker 已跑 20 分钟')
  expect(message).toContain('- 排队的告警：排队等 worker 已 16 分钟')
  expect(message).toContain('- 卡在人的告警：报告卡住，已等人 20 分钟')
  expect(message).toContain('[面板](https://panel.example/dsh/)')
  expect(message).not.toContain('刚开始的告警')
  expect(message).not.toContain('等审阅')
  // Nothing new on the next run; a running ticket that then passes the stop limit is stopped and posted again.
  await watch()
  expect(sent()).toHaveLength(1)
  tickets.find(ticket => ticket.id === 'slow0000bbbb')!.started = ago(31)
  await watch()
  expect(sent()).toHaveLength(2)
  expect(sent()[1]).toContain('**已停止** 慢的告警')
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))).not.toHaveProperty('stuck000cccc')
})

it('says nothing when every ticket is within its limits, and changes nothing on a dry run', async () => {
  tickets = tickets.slice(0, 1)
  await watch()
  expect(sent()).toEqual([])
  tickets.push({ id: 'stuck000cccc', title: '卡住的告警', stage: 'working', createdAt: ago(40), updatedAt: ago(1), started: ago(35) })
  const dry = await watch('--dry-run')
  expect(dry.stdout).toContain('would stop: - **已停止** 卡住的告警')
  expect(calls.filter(call => call.startsWith('POST'))).toEqual([])
  expect(sent()).toEqual([])
})

it('refuses a non-loopback API and limits in the wrong order before reading anything', async () => {
  expect(await watch('--url', 'https://panel.example')).toMatchObject({ code: 2, stderr: expect.stringContaining('loopback') })
  expect(await watch('--warn-minutes', '30', '--stop-minutes', '20')).toMatchObject({ code: 2 })
  expect(calls).toEqual([])
})
