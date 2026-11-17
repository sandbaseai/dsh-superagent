/** Tests for scripts/oncall-fix against a fake SandBase Agents API, a fake management API and a stub lark-cli. */
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'oncall-fix')
const TICKET = 'abcdef0123456789abcdef0123456789'
const MODEL_KEY = 'sk-model-secret-0001'
const SANDBASE_KEY = 'sb-agents-secret-0001'
type Item = Record<string, unknown>
type Session = { agent: string; input: string; status: string; items: Item[]; events: string[]; provider: Record<string, string> }
let root: string, agents: Server, panel: Server, agentsUrl: string, panelUrl: string
let sessions: Map<string, Session>, keys: string[]

const answer = (text: string): Item => ({ type: 'message', role: 'assistant', id: `msg-${Math.random()}`, content: [{ type: 'text', text }] })
const opened = (number: number): Item => ({ type: 'mcp_call', name: 'github_open_pull_request', status: 'completed', id: `call-${number}`,
  output: [{ type: 'text', text: JSON.stringify({ pr_url: `https://github.com/acme/site/pull/${number}`, pr_number: number, head_sha: 'f'.repeat(40) }) }] })
const review = (verdict: string, summary: string) => answer(`Done.\n${JSON.stringify({ verdict, risk: 'low', commented: true, head_sha: 'f'.repeat(40), blockers: [], summary })}`)
/** Finish a Session's turn with `items`, newest first as the API lists them. */
function finish(id: string, ...items: Item[]) { const session = sessions.get(id)!; session.items = [...items, ...session.items]; session.status = 'idle' }
const byAgent = (agent: string) => [...sessions.entries()].filter(([, session]) => session.agent === agent)

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'oncall fix '))
  sessions = new Map(); keys = []
  agents = createServer((request, response) => {
    let text = ''
    request.on('data', chunk => { text += chunk })
    request.on('end', () => {
      if (request.headers.authorization !== `Bearer ${SANDBASE_KEY}`) { response.writeHead(401); response.end(); return }
      const path = request.url!.replace(/^\/v1/, '')
      const body = text ? JSON.parse(text) : undefined
      if (request.headers['idempotency-key']) keys.push(String(request.headers['idempotency-key']))
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.method === 'POST' && path === '/agents/sessions') {
        const id = `ses_${sessions.size + 1}`
        sessions.set(id, { agent: body.agent_id, input: body.input, status: 'in_progress', items: [], events: [], provider: body.model_provider })
        response.end(JSON.stringify({ id })); return
      }
      const events = /^\/agents\/sessions\/(\w+)\/events$/.exec(path)
      if (events) { const session = sessions.get(events[1]!)!; session.events.push(body.input); session.status = 'in_progress'; response.end('{}'); return }
      const items = /^\/agents\/sessions\/(\w+)\/items/.exec(path)
      if (items) { response.end(JSON.stringify({ data: sessions.get(items[1]!)!.items, has_more: false })); return }
      const session = /^\/agents\/sessions\/(\w+)$/.exec(path)
      if (session) { response.end(JSON.stringify({ id: session[1], execution_status: sessions.get(session[1]!)!.status, failure: null })); return }
      response.writeHead(404); response.end()
    })
  })
  panel = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ channels: [{ source: 'feishu', address: { chatId: 'oc_alerts', messageId: 'om_alert' } }] }))
  })
  for (const server of [agents, panel]) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  agentsUrl = `http://127.0.0.1:${(agents.address() as AddressInfo).port}/v1`
  panelUrl = `http://127.0.0.1:${(panel.address() as AddressInfo).port}`
  // The script requires https; the test serves plain HTTP and rewrites the configured https address in the request.
  writeFileSync(join(root, 'fix.env'), ['SANDBASE_AGENTS_URL=https://agents.example/v1', `SANDBASE_API_KEY=${SANDBASE_KEY}`, 'FIX_AGENT_ID=agt_fix',
    'REVIEW_AGENT_ID=agt_review', '\u200bMODEL_BASE_URL=\u200bhttps://gateway.example', `MODEL_API_KEY=${MODEL_KEY}`].join('\n') + '\n', { mode: 0o600 })
  writeFileSync(join(root, 'lark'), `#!/bin/sh\nfor a; do [ "$prev" = --markdown ] && printf '%s\\n---\\n' "$a" >> ${JSON.stringify(join(root, 'replies.md'))}; prev=$a; done\n`, { mode: 0o755 })
  writeFileSync(join(root, 'brief.md'), 'Problem: /free-tools/photo-restoration returns 404. Evidence: CLB 08:36. Change: add a redirect.')
})
afterEach(() => { agents.close(); panel.close(); rmSync(root, { recursive: true, force: true }) })

function fix(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', ['-c', `import runpy, sys, urllib.request
sys.argv = ['oncall-fix', '--config', ${JSON.stringify(join(root, 'fix.env'))}, '--state', ${JSON.stringify(join(root, 'state.json'))}] + sys.argv[1:]
real = urllib.request.Request
urllib.request.Request = lambda url, *a, **k: real(url.replace('https://agents.example/v1', ${JSON.stringify(agentsUrl)}), *a, **k)
runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='__main__')`, ...args], { timeout: 30_000, env: { ...process.env, DSH_SUPERAGENT_TICKET: TICKET } },
  (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const tick = () => fix('tick', '--url', panelUrl, '--lark-cli', join(root, 'lark'))
const replies = () => existsSync(join(root, 'replies.md')) ? readFileSync(join(root, 'replies.md'), 'utf8').split('\n---\n').filter(Boolean) : []
const stage = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[TICKET]

it('starts one fix Session per ticket with the configured gateway, and refuses a second', async () => {
  const first = await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))
  expect(first.code, first.stderr).toBe(0)
  const [[, session]] = byAgent('agt_fix') as [[string, Session]]
  expect(session.provider).toEqual({ type: 'custom', base_url: 'https://gateway.example', api_key: MODEL_KEY })
  expect(session.input).toContain('Repository: acme/site')
  expect(session.input).toContain('/free-tools/photo-restoration returns 404')
  expect(first.stdout + first.stderr).not.toContain(MODEL_KEY)
  expect(await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))).toMatchObject({ code: 2, stdout: expect.stringContaining('already has a fix') })
  expect(sessions.size).toBe(1)
})

it('takes a fix through a requested change to an approved review, replying in the alert topic', async () => {
  await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))
  await tick()
  expect(stage().stage).toBe('fixing')
  finish('ses_1', answer('Opened #7.'), opened(7))
  await tick()
  expect(stage()).toMatchObject({ stage: 'review', round: 1, pr_url: 'https://github.com/acme/site/pull/7' })
  expect(byAgent('agt_review')[0]![1].input).toContain('Pull request: #7')
  finish('ses_2', review('changes_requested', '缺少 token-counter 的重定向'))
  await tick()
  expect(stage().stage).toBe('revising')
  expect(sessions.get('ses_1')!.events).toEqual([expect.stringContaining('Review round 1 comments were posted on pull request #7')])
  // The fix Session's earlier answer does not count as its revision.
  await tick()
  expect(stage().stage).toBe('revising')
  finish('ses_1', answer('Pushed the fix to the same branch.'))
  await tick()
  expect(stage()).toMatchObject({ stage: 'review', round: 2 })
  finish('ses_3', review('approve', '通过'))
  await tick()
  expect(stage().stage).toBe('ready')
  expect(replies()).toEqual([expect.stringMatching(/^\*\*已提交修复 PR\*\*：https:\/\/github\.com\/acme\/site\/pull\/7/),
    expect.stringContaining('<at user_id="all"></at> **审阅通过，等人合并**（低风险，第 2 轮）')])
  expect(keys).toContain(`oncall-review-${TICKET.slice(0, 16)}-r2`)
  // A finished fix is left alone.
  await tick()
  expect(sessions.size).toBe(3)
})

it('hands over to a person after two rounds with blockers, a review without a verdict, or no pull request', async () => {
  await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))
  finish('ses_1', answer('Opened #8.'), opened(8))
  await tick()
  finish('ses_2', review('changes_requested', 'a')); await tick()
  finish('ses_1', answer('Pushed.')); await tick()
  finish('ses_3', review('changes_requested', '仍然缺少测试')); await tick()
  expect(stage()).toMatchObject({ stage: 'needs_human', round: 2 })
  expect(replies().at(-1)).toContain('**2 轮审阅后仍有阻塞问题**，需要人看：https://github.com/acme/site/pull/8')

  rmSync(join(root, 'state.json')); rmSync(join(root, 'replies.md'))
  await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))
  finish('ses_4', answer('The fix needs a product decision on the new URLs, so I opened no pull request.'))
  await tick()
  expect(stage().stage).toBe('no_pr')
  expect(replies()).toEqual([expect.stringContaining('**自动修复没有开 PR**：The fix needs a product decision')])

  rmSync(join(root, 'state.json'))
  await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))
  finish('ses_5', answer('Opened #9.'), opened(9)); await tick()
  finish('ses_6', answer('I looked at it.')); await tick()
  expect(stage()).toMatchObject({ stage: 'needs_human', reason: 'the review gave no verdict' })
})

it('refuses a bad ticket, repository or brief, and a config others can read', async () => {
  expect(await fix('submit', '--repository', 'not a repo', '--brief', join(root, 'brief.md'))).toMatchObject({ code: 2 })
  writeFileSync(join(root, 'short.md'), 'fix it')
  expect(await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'short.md'))).toMatchObject({ code: 2, stderr: expect.stringContaining('brief') })
  expect(await fix('submit', '--ticket', 'nope', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))).toMatchObject({ code: 2 })
  writeFileSync(join(root, 'fix.env'), readFileSync(join(root, 'fix.env')), { mode: 0o644 })
  const { chmodSync } = await import('node:fs'); chmodSync(join(root, 'fix.env'), 0o644)
  expect(await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))).toMatchObject({ code: 2, stderr: expect.stringContaining('chmod 600') })
  expect(sessions.size).toBe(0)
})
