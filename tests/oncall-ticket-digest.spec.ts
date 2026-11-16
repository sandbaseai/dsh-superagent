/** Tests for scripts/oncall-ticket-digest against a fake management API, a stub gateway and a stub lark-cli. */
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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
    const items = url.searchParams.get('state') === 'ended' ? TICKETS : []
    const offset = Number(url.searchParams.get('offset')), limit = 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ items: items.slice(offset, offset + limit), total: items.length,
      next_offset: offset + limit < items.length ? offset + limit : null }))
  })
  await new Promise<void>(resolve => api!.listen(0, '127.0.0.1', resolve))
  apiUrl = `http://127.0.0.1:${(api!.address() as AddressInfo).port}`
  writeFileSync(join(root, 'credentials.yaml'), `version: 1\nrefs:\n  ONCALL_LLM_API_KEY: "${KEY}"\n`)
  writeFileSync(join(root, 'lark'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(root, 'sends.log'))}\ncat digest.md >> ${JSON.stringify(join(root, 'sent.md'))}\n`, { mode: 0o755 })
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
    '--credentials', join(root, 'credentials.yaml'), '--base-url', 'https://gateway.example', '--model', 'test-model', '--lark-cli', join(root, 'lark')])} + sys.argv[1:]
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
  expect(sent).not.toContain('旧链接 404')
  const known = JSON.parse(readFileSync(join(root, 'known.json'), 'utf8'))
  expect(known).toEqual([expect.objectContaining({ key: 'provider-a-billing', tickets: 2, status: 'open', needs_human: true })])
  expect(readFileSync(join(root, 'known.md'), 'utf8')).toContain('**provider-a 计费停用**（`provider-a-billing`，需要人处理，2 张工单')
  expect(readFileSync(join(root, 'sends.log'), 'utf8')).toBe('im +messages-send --chat-id oc_digest --markdown @digest.md --as bot\n')
  expect(result.stdout + result.stderr).not.toContain(KEY)
  // The last page it read held the first ticket older than the window; nothing after it was read.
  expect(listed.filter(path => path.includes('state=ended'))).toHaveLength(4)
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

it('refuses a bad chat, a missing model or a non-loopback API before reading anything', async () => {
  const base = await gateway(answer)
  expect(await digest(base, '--url', 'https://panel.example')).toMatchObject({ code: 2, stderr: expect.stringContaining('--url must be the loopback') })
  expect(await digest(base, '--chat', 'nope')).toMatchObject({ code: 2, stderr: expect.stringContaining('--chat must be') })
  expect(await digest(base, '--model', '')).toMatchObject({ code: 2, stderr: expect.stringContaining('--model are required') })
  expect(seen).toHaveLength(0)
  expect(listed).toHaveLength(0)
})
