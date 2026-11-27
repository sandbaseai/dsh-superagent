/** Tests for scripts/oncall-ticket-digest against a fake management API, a stub gateway and a stub lark-cli. */
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'oncall-ticket-digest')
const KEY = 'gateway-key-0123456789'
let root: string, server: Server | undefined, api: Server | undefined, apiUrl: string
let listed: string[] = []
let seen: { headers: Record<string, unknown>; body: { model: string; messages: { content: string }[] } }[] = []

/** A ticket as the management API lists it: newest updated first, with the latest report's summary. */
const ticket = (id: string, minutesAgo: number, title: string, conclusion: string) => {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return { id: `${id}${'0'.repeat(24)}`, title, createdAt: at, updatedAt: at, ended: { outcome: 'completed' },
    summary: `**结论**: ${conclusion}\n**证据**: x` }
}
const TICKETS = [ticket('aaaaaaaa', 30, 'p0 · provider-a 不可用', '计费停用，403'), ticket('cccccccc', 60, '404 · /old', '旧链接'),
  ticket('bbbbbbbb', 90, 'p0 · provider-a 不可用', '计费停用，仍是 403'), ticket('dddddddd', 3000, '很早的工单', '已过期')]

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ticket digest '))
  listed = []
  // The management API pages the ended tickets one at a time, so the script must follow next_offset and stop at the window.
  api = createServer((request, response) => {
    const url = new URL(request.url!, 'http://x')
    listed.push(`${url.pathname}?${url.searchParams}`)
    if (request.headers['x-orchestrator-request'] !== '1') { response.writeHead(403); response.end(); return }
    if (url.pathname.endsWith('/state')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ setup: { accounts: { feishu: { appId: 'cli_ours' } } } })); return
    }
    if (url.pathname.endsWith('/decisions')) {
      const items = [{ thread: 'feishu:oc_alerts:alert:k1', threadTitle: 'p1/Rule · a', at: new Date().toISOString(), reason: [{ code: 'routed', values: { ticket: 'aaaaaaaa' } }] },
        { thread: 'feishu:oc_alerts:alert:k2', threadTitle: 'p2/Other · b', at: new Date().toISOString(), reason: [{ code: 'said', values: { text: 'repeat' } }] },
        { thread: 'feishu:oc_alerts:om_x', at: new Date().toISOString(), reason: [{ code: 'routed', values: { ticket: 'aaaaaaaa' } }] },
        { thread: 'feishu:oc_alerts:alert:k3', threadTitle: 'p1/Rule · c', at: new Date().toISOString(), reason: [{ code: 'routed', values: { ticket: 'bbbbbbbb' } }] }]
      const offset = Number(url.searchParams.get('offset'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ items: items.slice(offset, offset + 2), next_offset: offset + 2 < items.length ? offset + 2 : null })); return
    }
    const detail = /\/tickets\/(\w+)$/.exec(url.pathname)
    if (detail) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ channels: [{ source: 'feishu', address: { chatId: 'oc_alerts', messageId: `om_${detail[1]!.slice(0, 8)}` } }] }))
      return
    }
    const items = url.searchParams.get('state') === 'ended' ? TICKETS : []
    const offset = Number(url.searchParams.get('offset')), limit = 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ items: items.slice(offset, offset + limit), total: items.length,
      next_offset: offset + limit < items.length ? offset + limit : null }))
  })
  await new Promise<void>(resolve => api!.listen(0, '127.0.0.1', resolve))
  apiUrl = `http://127.0.0.1:${(api!.address() as AddressInfo).port}`
  writeFileSync(join(root, 'credentials.yaml'), `version: 1\nrefs:\n  ONCALL_LLM_API_KEY: "${KEY}"\n`)
  // The stub lark-cli sends by recording, and answers the topic and reaction reads: aaaaaaaa's reply has two people's 👍 and the
  // bot's own, cccccccc's one person's 👎; the alert bot's message in the topic is not the agent's reply.
  writeFileSync(join(root, 'lark'), `#!/usr/bin/env python3
import json, os, re, sys
args = sys.argv[1:]
root = ${JSON.stringify(root)}
if os.path.exists(os.path.join(root, 'lark-fails')) and args[0] == 'api': sys.exit(1)
if args[0] != 'api':
    open(os.path.join(root, 'sends.log'), 'a').write(' '.join(args) + '\\n')
    open(os.path.join(root, 'sent.md'), 'a').write(open('digest.md').read())
    sys.exit(0)
path = args[2]
def answer(data): print(json.dumps({'ok': True, 'data': data})); sys.exit(0)
m = re.fullmatch(r'/open-apis/im/v1/messages/om_(\\w{8})', path)
if m: answer({'items': [{'thread_id': 'omt_' + m.group(1)}]})
if path == '/open-apis/im/v1/messages':
    topic = json.loads(args[args.index('--params') + 1])['container_id'][4:]
    answer({'items': [{'message_id': 'om_alert', 'sender': {'id': 'cli_alerts'}}, {'message_id': 'om_r' + topic, 'sender': {'id': 'cli_ours'}}]})
m = re.fullmatch(r'/open-apis/im/v1/messages/om_r(\\w{8})/reactions', path)
user = lambda emoji, kind='user': {'reaction_type': {'emoji_type': emoji}, 'operator': {'operator_type': kind}}
reactions = {'aaaaaaaa': [user('THUMBSUP'), user('THUMBSUP'), user('THUMBSUP', 'app')], 'cccccccc': [user('ThumbsDown')]}
answer({'items': reactions.get(m.group(1), []) if m else []})
`, { mode: 0o755 })
  seen = []
})
afterEach(() => { server?.close(); server = undefined; api?.close(); api = undefined; rmSync(root, { recursive: true, force: true }) })

async function gateway(answer: unknown): Promise<string> {
  server = createServer((request, response) => {
    let text = ''
    request.on('data', chunk => { text += chunk })
    request.on('end', () => {
      seen.push({ headers: request.headers, body: JSON.parse(text) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'Here it is:\n' + JSON.stringify(answer) }] }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
function digest(base: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // The script requires https; the test runs a plain-HTTP stub through an override only the test sets.
  return new Promise(resolve => execFile('python3', ['-c', `import runpy, sys, urllib.request
sys.argv = ${JSON.stringify(['oncall-ticket-digest', '--url', apiUrl, '--known', join(root, 'known.json'), '--chat', 'oc_digest',
    '--credentials', join(root, 'credentials.yaml'), '--fix-state', join(root, 'fixes.json'), '--base-url', 'https://gateway.example', '--model', 'test-model', '--lark-cli', join(root, 'lark')])} + sys.argv[1:]
real = urllib.request.Request
urllib.request.Request = lambda url, *a, **k: real(url.replace('https://gateway.example', ${JSON.stringify(base)}), *a, **k)
runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='__main__')`, ...args], { timeout: 30_000 },
  (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const answer = { headline: '3 张工单，1 个问题要人处理', issues: [
  { key: 'Provider A Billing', title: 'provider-a 计费停用', cause: '项目计费停用，所有请求 403', action: '恢复计费', owner: '供应商对接', needs_human: true,
    ticket_ids: ['aaaaaaaa', 'bbbbbbbb', 'zzzzzzzz'] },
  { key: 'old-links', title: '旧链接 404', cause: '旧收藏', action: '无需处理', owner: '无', needs_human: false, ticket_ids: [] }] }

it('groups the window\'s tickets through the gateway, posts the digest and writes the known list for workers', async () => {
  const result = await digest(await gateway(answer))
  expect(result.code, result.stderr).toBe(0)
  expect(seen[0]!.headers['x-api-key']).toBe(KEY)
  expect(seen[0]!.body.model).toBe('test-model')
  const prompt = seen[0]!.body.messages[0]!.content
  expect(prompt).toContain('计费停用，仍是 403')
  expect(prompt).not.toContain('很早的工单')
  const sent = readFileSync(join(root, 'sent.md'), 'utf8')
  expect(sent).toContain('3 张工单，归为 2 类')
  expect(sent).toContain('**需要人处理**\n- **provider-a 计费停用**（2 张，供应商对接）：恢复计费')
  // A ticket the model left out is listed under 未归类; an issue with no ticket of the window is dropped.
  expect(sent).toContain('未归类（1 张）')
  // Alarms attached to an existing ticket, across pages, count; a repeat or a person's message does not.
  expect(sent).toContain('**告警归并**：过去 24 小时 2 条告警挂到已有工单复核，没有新开工单。')
  expect(sent).not.toContain('旧链接 404')
  const known = JSON.parse(readFileSync(join(root, 'known.json'), 'utf8'))
  expect(known).toEqual([expect.objectContaining({ key: 'provider-a-billing', tickets: 2, status: 'open', needs_human: true })])
  expect(readFileSync(join(root, 'known.md'), 'utf8')).toContain('**provider-a 计费停用**（`provider-a-billing`，需要人处理，2 张工单')
  expect(readFileSync(join(root, 'sends.log'), 'utf8')).toBe('im +messages-send --chat-id oc_digest --markdown @digest.md --as bot\n')
  expect(result.stdout + result.stderr).not.toContain(KEY)
  // Each of the two reads (the window, then the feedback window) stopped there; nothing after it was read.
  expect(listed.filter(path => path.includes('state=ended'))).toHaveLength(8)
  expect(listed).not.toContain('/orchestrator/api/tickets?state=ended&offset=4&limit=200')
  expect(sent).toContain('**分析反馈**（过去 48 小时 3 张工单，2 张有反馈）：👍 2 · 👎 1')
  expect(sent).toContain('- 👎 404 · /old（')
  // The next run passes the known list to the model and adds to the same key's count.
  await digest(await gateway(answer))
  expect(seen.at(-1)!.body.messages[0]!.content).toContain('provider-a-billing')
  expect(JSON.parse(readFileSync(join(root, 'known.json'), 'utf8'))[0].tickets).toBe(4)
})

it('marks an issue quiet after two days without tickets, drops it after a week, and writes nothing on a dry run', async () => {
  const day = 86_400_000
  writeFileSync(join(root, 'known.json'), JSON.stringify([
    { key: 'quiet-one', title: 'q', cause: '', action: '', owner: '', needs_human: false, tickets: 3, status: 'open',
      firstSeen: new Date(Date.now() - 5 * day).toISOString(), lastSeen: new Date(Date.now() - 3 * day).toISOString() },
    { key: 'gone', title: 'g', cause: '', action: '', owner: '', needs_human: false, tickets: 1, status: 'open',
      firstSeen: new Date(Date.now() - 9 * day).toISOString(), lastSeen: new Date(Date.now() - 8 * day).toISOString() }]))
  const before = readFileSync(join(root, 'known.json'), 'utf8')
  const dry = await digest(await gateway(answer), '--dry-run')
  expect(dry.code, dry.stderr).toBe(0)
  expect(dry.stdout).toContain('**q**（`quiet-one`，安静')
  expect(dry.stdout).not.toContain('`gone`')
  expect(readFileSync(join(root, 'known.json'), 'utf8')).toBe(before)
  expect(existsSync(join(root, 'sends.log'))).toBe(false)
})

it('checks the evidence of the replies whose worker Session is here, and lists those asserting what the worker never saw', async () => {
  // aaaaaaaa's worker queried and was told 403; cccccccc's Session is not on this machine, so only one ticket is checked.
  const session = join(root, 'sessions', 'p1', `worker-aaaaaaaa${'0'.repeat(24)}`)
  mkdirSync(session, { recursive: true })
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'alarm card: provider-a failing' }] } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"dsh-oncall cls --query 403"}' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '412 rows status 403' }] } } }]
  writeFileSync(join(session, 'session.v4.jsonl'), events.map(event => JSON.stringify(event)).join('\n'))
  execFileSync('zstd', ['-q', '--rm', join(session, 'session.v4.jsonl'), '-o', join(session, 'session.v4.jsonl.zstd')])
  const base = await gateway({ ...answer, major: ['影响段写“其他客户不受影响”，但没有查过其他客户。'], minor: [] })
  const result = await digest(base, '--sessions', join(root, 'sessions'), '--check', '5')
  expect(result.code, result.stderr).toBe(0)
  const check = seen.find(request => request.body.messages[0]!.content.startsWith('You audit an on-call agent'))!
  expect(check.body.messages[0]!.content).toContain('[result] 412 rows status 403')
  expect(check.body.messages[0]!.content).toContain('**结论**: 计费停用，403')
  expect(seen.filter(request => request.body.messages[0]!.content.startsWith('You audit'))).toHaveLength(1)
  const sent = readFileSync(join(root, 'sent.md'), 'utf8')
  expect(sent).toContain('**证据抽查**（1 张给出原因的工单）：1 张结论缺证据或与证据矛盾；0 张只有细节问题。')
  expect(sent).toContain('- p0 · provider-a 不可用（`aaaaaaaa`）：影响段写“其他客户不受影响”，但没有查过其他客户。')
  expect(await digest(base, '--sessions', join(root, 'missing'))).toMatchObject({ code: 2 })
  expect(await digest(base, '--check', '31')).toMatchObject({ code: 2 })
})

it('refuses a bad chat, a missing model or a non-loopback API before reading anything', async () => {
  const base = await gateway(answer)
  expect(await digest(base, '--url', 'https://panel.example')).toMatchObject({ code: 2, stderr: expect.stringContaining('--url must be the loopback') })
  expect(await digest(base, '--chat', 'nope')).toMatchObject({ code: 2, stderr: expect.stringContaining('--chat must be') })
  expect(await digest(base, '--model', '')).toMatchObject({ code: 2, stderr: expect.stringContaining('--model are required') })
  expect(seen).toHaveLength(0)
  expect(listed).toHaveLength(0)
})

it('posts the digest without feedback when Feishu reads fail', async () => {
  writeFileSync(join(root, 'lark-fails'), '')
  const result = await digest(await gateway(answer))
  expect(result.code, result.stderr).toBe(0)
  expect(result.stderr).toContain('feedback not read')
  expect(readFileSync(join(root, 'sent.md'), 'utf8')).toContain('**分析反馈**：这次没读到')
})

it('counts the fixes oncall-fix started in the feedback window and lists those waiting for a person', async () => {
  const at = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString()
  writeFileSync(join(root, 'fixes.json'), JSON.stringify({
    a: { created: at(2), stage: 'ready', repository: 'acme/site', pr_url: 'https://github.com/acme/site/pull/7' },
    b: { created: at(3), stage: 'review', repository: 'acme/site' },
    c: { created: at(5), stage: 'needs_human', repository: 'acme/site', pr_url: 'https://github.com/acme/site/pull/8' },
    d: { created: at(100), stage: 'ready', repository: 'acme/old', pr_url: 'https://github.com/acme/old/pull/1' } }))
  expect((await digest(await gateway(answer))).code).toBe(0)
  const sent = readFileSync(join(root, 'sent.md'), 'utf8')
  expect(sent).toContain('**自动修复**（过去 48 小时发起 3 个）：进行中 1 · 等人合并 1 · 已发布 0 · 没开 PR 0 · 需要人看 1')
  expect(sent).toContain('修复 PR 等人合并：https://github.com/acme/site/pull/7')
  expect(sent).toContain('修复没成功（needs_human）：https://github.com/acme/site/pull/8')
  expect(sent).toContain('acme/old')
  expect(sent).toContain('年龄 4 天 4 小时')
  expect(sent).toContain('未决提议 3 个')
})

it('requires explicit verification to close a released issue, including one with no new tickets', async () => {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  // The stub lark-cli appends every send to sent.md.
  const latest = () => '**工单日报' + readFileSync(join(root, 'sent.md'), 'utf8').split('**工单日报').at(-1)
  const fix = (minutes: number, result?: string, needs_attention = false) => JSON.stringify({ b: {
    ticket: `bbbbbbbb${'0'.repeat(24)}`, created: at(200), stage: 'released', since: at(minutes),
    verification: result ? { result, evidence: 'PRIVATE_EVIDENCE' } : undefined, needs_attention,
    release_tag: 'v1.2.3', repository: 'acme/site', pr_url: 'https://github.com/acme/site/pull/9' } })
  // Released 60 minutes ago: aaaaaaaa, 30 minutes ago, came after it.
  writeFileSync(join(root, 'fixes.json'), fix(60))
  expect((await digest(await gateway(answer))).code).toBe(0)
  let sent = latest()
  expect(seen.at(-1)!.body.messages[0]!.content).toContain('"id": "bbbbbbbb",')
  expect(seen.at(-1)!.body.messages[0]!.content).toContain('"fix_pr": "https://github.com/acme/site/pull/9"')
  expect(sent).toContain('待验证，发布后仍有 1 张')
  expect(readFileSync(join(root, 'known.md'), 'utf8')).toContain('已发布：https://github.com/acme/site/pull/9')
  // Silence, failed verification and an attention flag must all keep the issue open.
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  for (const [result, attention] of [[undefined, false], ['failed', false], ['passed', true]] as const) {
    writeFileSync(join(root, 'fixes.json'), fix(10, result, attention))
    expect((await digest(base, '--feedback-hours', '0')).code).toBe(0)
    sent = latest()
    expect(sent).toContain('**需要人处理**')
    expect(sent).not.toContain('**已修复**')
    expect(sent).toContain(result ? '验证未通过' : '待验证')
    expect(sent).not.toContain('PRIVATE_EVIDENCE')
  }
  writeFileSync(join(root, 'fixes.json'), fix(10, 'passed'))
  expect((await digest(base, '--feedback-hours', '0')).code).toBe(0)
  sent = latest()
  expect(sent).not.toContain('**需要人处理**')
  expect(sent).toContain('**已修复**\n- provider-a 计费停用（2 张，都在发布前）：已发布：https://github.com/acme/site/pull/9')
  expect(sent).toContain('验证通过')
  // A day with no ticket of a known issue whose fix was released in the window still says it was fixed.
  const quiet = { headline: '', issues: [{ key: 'other', title: '别的问题', cause: '', action: '', owner: '', needs_human: false,
    ticket_ids: ['aaaaaaaa', 'cccccccc'] }] }
  expect((await digest(await gateway(quiet))).code).toBe(0)
  sent = latest()
  expect(sent).toMatch(/\*\*已修复\*\*\n- provider-a 计费停用：已发布：https:\/\/github\.com\/acme\/site\/pull\/9（.*），验证通过，之后没有新工单/)
  const quietBase = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  for (const result of [undefined, 'failed']) {
    writeFileSync(join(root, 'fixes.json'), fix(10, result))
    expect((await digest(quietBase, '--feedback-hours', '0')).code).toBe(0)
    sent = latest()
    expect(sent).not.toContain('**已修复**')
    expect(sent).toContain('未决提议 1 个')
    expect(sent).toContain(result ? '验证未通过' : '待验证')
  }
})

it('keeps old unresolved proposals visible without recent starts and caps details at ten', async () => {
  const stages = ['pending_confirmation', 'ready', 'needs_human', 'failed', 'release_failed', 'merged', 'released', 'released', 'merged', 'pending', 'ready', 'failed']
  const fixes = stages.map((stage, i) => ({ stage, created: new Date(Date.now() - (200 - i) * 3600_000).toISOString(),
    since: new Date().toISOString(), ticket: `origin${String(i).padStart(2, '0')}`, tickets: [`origin${String(i).padStart(2, '0')}`, 'related1', 'related1'],
    repository: 'acme/site', problem_key: `problem-${i}`, brief: 'PRIVATE_BRIEF',
    verification: i === 7 ? { result: 'failed', evidence: 'PRIVATE_EVIDENCE' } : i === 8 ? { result: 'passed' } : undefined,
    needs_attention: i === 8 }))
  writeFileSync(join(root, 'fixes.json'), JSON.stringify(Object.fromEntries([
    ...fixes.map((fix, i) => [i, fix]),
    ['dismissed', { ...fixes[0], stage: 'dismissed', problem_key: 'excluded-dismissed' }],
    ['passed', { ...fixes[6], verification: { result: 'passed' }, problem_key: 'excluded-passed' }],
  ])))
  const result = await digest(await gateway(answer), '--feedback-hours', '0')
  expect(result.code, result.stderr).toBe(0)
  const sent = readFileSync(join(root, 'sent.md'), 'utf8')
  expect(sent).toContain('过去 48 小时发起 0 个')
  expect(sent).toContain('未决提议 12 个')
  expect(sent).toContain('另有 2 个未决提议未展示')
  expect(sent.match(/；问题 `/g)).toHaveLength(10)
  expect(sent).toContain('修复提议待确认')
  expect(sent).toContain('年龄 8 天 8 小时；原工单 `origin00`；关联工单 2 张')
  expect(sent).toContain('已发布：acme/site')
  expect(sent).toContain('修复已合并、还没发布：acme/site，验证未通过')
  expect(sent).not.toMatch(/PRIVATE_BRIEF|PRIVATE_EVIDENCE|excluded-dismissed|excluded-passed|`problem-10`/)
})

it('matches associated tickets to a proposal and renders confirmation and dismissal without private text', async () => {
  const base = await gateway(answer)
  for (const stage of ['pending_confirmation', 'dismissed']) {
    writeFileSync(join(root, 'fixes.json'), JSON.stringify({ proposal: {
      stage, ticket: 'original00000000', tickets: ['original00000000', `bbbbbbbb${'0'.repeat(24)}`],
      repository: 'acme/site', problem_key: 'billing', created: new Date().toISOString(),
      brief: 'PRIVATE_BRIEF', verification: { result: 'failed', evidence: 'PRIVATE_EVIDENCE' },
    } }))
    const result = await digest(base, '--feedback-hours', '0')
    expect(result.code, result.stderr).toBe(0)
    const known = JSON.parse(readFileSync(join(root, 'known.json'), 'utf8'))
    expect(known[0].fix_ticket).toBe('original')
    const sent = readFileSync(join(root, 'sent.md'), 'utf8').split('**工单日报').at(-1)!
    expect(sent).toContain(stage === 'dismissed' ? '修复提议已驳回' : '修复提议待确认')
    expect(sent).not.toMatch(/PRIVATE_BRIEF|PRIVATE_EVIDENCE/)
  }
})

it('posts a short alarm summary with --brief: counts, then only attention items that cite a ticket and pass the review', async () => {
  const brief = { headline: '以已知问题为主', ongoing: [{ title: '旧链接 404', alarms: 7 }], attention: [
    { title: 'provider-a 计费停用', why: '所有请求 403，需要恢复计费', ticket_ids: ['aaaaaaaa'] },
    { title: '旧链接 404 很多', why: '要人看', ticket_ids: ['cccccccc'] },
    { title: '没有工单的猜测', why: '模型自己想的', ticket_ids: ['zzzzzzzz'] },
    { title: '低置信度的计费', why: '可能要处理', ticket_ids: ['bbbbbbbb'] }] }
  // The review keeps the first, drops the second, and doubts the fourth; the third cites no ticket and is never reviewed.
  const verdicts = { verdicts: [{ index: 0, verdict: 'keep' }, { index: 1, verdict: 'drop' }, { index: 2, verdict: 'doubt' }] }
  server = createServer((request, response) => {
    let text = ''
    request.on('data', chunk => { text += chunk })
    request.on('end', () => {
      const body = JSON.parse(text)
      seen.push({ headers: request.headers, body })
      const answer = body.messages[0].content.startsWith('You check a summary') ? verdicts : brief
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(answer) }] }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const result = await digest(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`, '--brief')
  expect(result.code, result.stderr).toBe(0)
  expect(seen[0]!.body.messages[0]!.content).toContain('p1/Rule: 2')
  const review = seen[1]!.body.messages[0]!.content
  expect(review).toContain('计费停用，403')
  expect(review).not.toContain('没有工单的猜测')
  expect(result.stderr).toContain('2 of 4 attention items left out by the checks')
  const sent = readFileSync(join(root, 'sent.md'), 'utf8')
  expect(sent).toMatch(/^\*\*告警摘要 \d\d:\d\d–\d\d:\d\d\*\*（3 条告警：新开工单 0 · 复核 2 · 重复已跳过 0 · 恢复 0 · 其他 1）/)
  expect(sent).toContain('**需要关注**\n- **provider-a 计费停用**：所有请求 403，需要恢复计费（工单 `aaaaaaaa`）\n- **低置信度的计费**（待确认）：可能要处理（工单 `bbbbbbbb`）\n')
  expect(sent).not.toContain('旧链接 404 很多')
  expect(sent).not.toContain('没有工单的猜测')
  expect(sent).toContain('**持续中的已知问题**\n- 旧链接 404（7 条）')
  expect(existsSync(join(root, 'known.json'))).toBe(false)
})
