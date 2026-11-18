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
type Session = { agent: string; input: string; status: string; items: Item[]; events: string[]; provider: Record<string, string>; workspace?: Record<string, string> }
let root: string, agents: Server, panel: Server, agentsUrl: string, panelUrl: string
let sessions: Map<string, Session>, keys: string[]

const answer = (text: string): Item => ({ type: 'message', role: 'assistant', id: `msg-${Math.random()}`, content: [{ type: 'text', text }] })
const opened = (number: number): Item => ({ type: 'mcp_call', name: 'github_open_pull_request', status: 'completed', id: `call-${number}`,
  output: [{ type: 'text', text: JSON.stringify({ pr_url: `https://github.com/acme/site/pull/${number}`, pr_number: number, head_sha: 'f'.repeat(40) }) }] })
const mergedBy = (number: number, merged = true): Item => ({ type: 'mcp_call', name: 'github_merge_pull_request', status: 'completed', id: `merge-${number}`,
  output: [{ type: 'text', text: JSON.stringify(merged ? { merged: true, pr_number: number, merge_commit_sha: 'a'.repeat(40) } : { error: { code: 'conflict', reason: 'head_changed' } }) }] })
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
        sessions.set(id, { agent: body.agent_id, input: body.input, status: 'in_progress', items: [], events: [], provider: body.model_provider, workspace: body.github_workspace })
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
    'REVIEW_AGENT_ID=agt_review', 'DEV_AGENT_ID=agt_dev', '\u200bMODEL_BASE_URL=\u200bhttps://gateway.example', `MODEL_API_KEY=${MODEL_KEY}`, 'REPOSITORIES=acme/site@4242,acme/admin@4343'].join('\n') + '\n', { mode: 0o600 })
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
  await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'), '--by', 'ou_alice')
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
    expect.stringMatching(/^<at user_id="ou_alice"><\/at> \*\*审阅通过，等人合并\*\*（低风险，第 2 轮）/)])
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
  // Without --by no one is mentioned, and never everyone.
  expect(replies().at(-1)).toMatch(/^\*\*2 轮审阅后仍有阻塞问题\*\*，需要人看：https:\/\/github\.com\/acme\/site\/pull\/8/)

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

it('starts a design with the dev Agent after a fix opened no pull request, one request at a time, and reviews it as a design', async () => {
  await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))
  writeFileSync(join(root, 'design.md'), 'Request: 出个具体的设计方案吧，把方案写到 PR 里. Evidence: the daily summary rescans predictions every 10 min.')
  const busy = await fix('submit', '--kind', 'design', '--repository', 'acme/admin', '--brief', join(root, 'design.md'))
  expect(busy).toMatchObject({ code: 2, stdout: expect.stringContaining('in progress') })
  finish('ses_1', answer('The change needs a design decision, so I opened no pull request.'))
  await tick()
  expect(stage().stage).toBe('no_pr')

  const design = await fix('submit', '--kind', 'design', '--repository', 'acme/admin', '--brief', join(root, 'design.md'))
  expect(design.code, design.stderr).toBe(0)
  const [[id, session]] = byAgent('agt_dev') as [[string, Session]]
  expect(session.input).toContain('Task: write a design proposal as a pull request')
  expect(session.input).toContain('出个具体的设计方案吧')
  expect(keys).toContain(`oncall-design-${TICKET.slice(0, 16)}-2`)
  finish(id, answer('Opened #12.'), opened(12))
  await tick()
  const entry = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[`${TICKET}:2`]
  expect(entry).toMatchObject({ kind: 'design', stage: 'review', pr_url: 'https://github.com/acme/site/pull/12' })
  expect(byAgent('agt_review')[0]![1].input).toContain('Kind: design')
  expect(keys).toContain(`oncall-review-${TICKET.slice(0, 16)}-2-r1`)
  expect(replies().at(-1)).toMatch(/^\*\*已提交设计方案 PR\*\*：https:\/\/github\.com\/acme\/site\/pull\/12/)
  finish('ses_3', review('approve', '方案清楚')); await tick()
  expect(replies().at(-1)).toContain('**审阅通过，等人合并**')
  // A design that opened a pull request is not asked for again, and a ticket gets one fix.
  expect(await fix('submit', '--kind', 'design', '--repository', 'acme/admin', '--brief', join(root, 'design.md')))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('already has a design pull request') })
  expect(await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md')))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('already has a fix') })
  expect(sessions.size).toBe(3)
})

it('refuses a design without a dev Agent configured, and a fourth request on a ticket', async () => {
  const env = readFileSync(join(root, 'fix.env'), 'utf8')
  writeFileSync(join(root, 'fix.env'), env.replace('DEV_AGENT_ID=agt_dev\n', ''), { mode: 0o600 })
  expect(await fix('submit', '--kind', 'design', '--repository', 'acme/admin', '--brief', join(root, 'brief.md')))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('lacks DEV_AGENT_ID') })
  writeFileSync(join(root, 'fix.env'), env, { mode: 0o600 })
  const ended = (n: number) => ({ ticket: TICKET, kind: 'design', repository: 'acme/admin', brief: 'b', stage: 'no_pr', created: '2026-11-18T00:00:00+00:00',
    since: '2026-11-18T00:00:00+00:00', tag: `t${n}` })
  writeFileSync(join(root, 'state.json'), JSON.stringify({ [TICKET]: ended(1), [`${TICKET}:2`]: ended(2), [`${TICKET}:3`]: ended(3) }))
  expect(await fix('submit', '--kind', 'design', '--repository', 'acme/admin', '--brief', join(root, 'brief.md')))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('already had 3 requests') })
  expect(sessions.size).toBe(0)
})

it('merges a reviewed pull request through the Session that opened it, only when a person asks, and only the reviewed head', async () => {
  await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))
  expect(await fix('merge')).toMatchObject({ code: 2, stdout: expect.stringContaining('no pull request of this ticket passed review') })
  finish('ses_1', answer('Opened #7.'), opened(7)); await tick()
  finish('ses_2', review('approve', '通过')); await tick()
  expect(replies().at(-1)).toContain('回复「合并」，由 Agent 合并')

  // The head changed since the review: the Agent does not merge, and the fix waits again.
  expect(await fix('merge', '--by', 'not-an-id')).toMatchObject({ code: 2, stderr: expect.stringContaining('--by') })
  expect(await fix('merge', '--by', 'ou_bob')).toMatchObject({ code: 0 })
  expect(stage()).toMatchObject({ stage: 'merging', head_sha: 'f'.repeat(40), by: 'ou_bob' })
  expect(sessions.get('ses_1')!.events.at(-1)).toContain(`expected_head_sha ${'f'.repeat(40)}`)
  expect(await fix('merge')).toMatchObject({ code: 2 })
  finish('ses_1', mergedBy(7, false), answer('conflict head_changed: the branch moved after review.'))
  await tick()
  expect(stage().stage).toBe('ready')
  expect(replies().at(-1)).toMatch(/^<at user_id="ou_bob"><\/at> \*\*没有合并\*\*：conflict head_changed/)

  expect(await fix('merge', '--pr', '7')).toMatchObject({ code: 0 })
  expect(keys.filter(key => key.startsWith('oncall-merge-'))).toEqual([`oncall-merge-${TICKET.slice(0, 16)}-7-1`, `oncall-merge-${TICKET.slice(0, 16)}-7-2`])
  finish('ses_1', answer('Merged #7.'), mergedBy(7)); await tick()
  expect(stage()).toMatchObject({ stage: 'merged', merge_sha: 'a'.repeat(40) })
  expect(replies().at(-1)).toBe('**已合并**：https://github.com/acme/site/pull/7')
  expect(await fix('merge')).toMatchObject({ code: 2 })
})

const called = (name: string, result: unknown): Item => ({ type: 'mcp_call', name, status: 'completed', id: `${name}-${Math.random()}`, output: [{ type: 'text', text: JSON.stringify(result) }] })
const MAIN = 'c'.repeat(40)
const tagged = (tag: string) => called('github_create_tag', { tag, sha: MAIN, url: `https://github.com/acme/site/releases/tag/${tag}` })
const dispatched = (runId: string | null) => called('github_dispatch_workflow', { status: 'dispatched', run_id: runId, html_url: runId ? `https://github.com/acme/site/actions/runs/${runId}` : null, workflow_path: '.github/workflows/deploy.yaml', ref: 'main' })
const runOf = (runId: string, conclusion: string, created = new Date(Date.now() + 1000).toISOString()) => called('github_read_workflow_runs', { run: { run_id: runId, event: 'workflow_dispatch', head_sha: MAIN, status: 'completed', conclusion, created_at: created, html_url: `https://github.com/acme/site/actions/runs/${runId}` } })
const withReleases = () => writeFileSync(join(root, 'fix.env'), readFileSync(join(root, 'fix.env'), 'utf8') + 'RELEASES=acme/site:.github/workflows/deploy.yaml\n', { mode: 0o600 })
async function ready() {
  await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))
  finish(stage().fix_session, answer('Opened #7.'), opened(7)); await tick()
  finish(stage().review_session, review('approve', '通过')); await tick()
  expect(stage().stage).toBe('ready')
}

it('releases a fix it merged: a new Session with the repository cloned tags main, dispatches the workflow and reports the run', async () => {
  withReleases(); await ready()
  expect(replies().at(-1)).toContain('合并后自动发布生产。')
  await fix('merge')
  finish('ses_1', answer('Merged #7.'), mergedBy(7)); await tick()
  expect(stage()).toMatchObject({ stage: 'releasing', release_session: 'ses_3', release_attempts: 1 })
  expect(replies().at(-1)).toBe('**已合并**：https://github.com/acme/site/pull/7\n开始发布生产，结果会回复在这里。')
  const release = sessions.get('ses_3')!
  expect(release).toMatchObject({ agent: 'agt_fix', workspace: { repository_id: '4242' } })
  // Every Session of a listed repository works in its clone: the fix, its review and its release.
  expect([...sessions.values()].map(session => session.workspace)).toEqual([{ repository_id: '4242' }, { repository_id: '4242' }, { repository_id: '4242' }])
  expect(release.input).toMatch(/^oncall-fix release request: pull request #7/)
  expect(release.input).toContain(`git merge-base --is-ancestor ${'a'.repeat(40)} origin/main`)
  expect(release.input).toContain(`idempotency_key oncall-release-${TICKET.slice(0, 16)}-1-tag`)
  expect(release.input).toContain('workflow_path .github/workflows/deploy.yaml')
  await tick()
  expect(stage().stage).toBe('releasing')
  finish('ses_3', answer('Released v0.2.11: success.'), runOf('99', 'success'), dispatched('99'), tagged('v0.2.11')); await tick()
  expect(stage()).toMatchObject({ stage: 'released', release_tag: 'v0.2.11', release_sha: MAIN })
  expect(replies().at(-1)).toBe('**已发布 v0.2.11**：https://github.com/acme/site/pull/7\n部署：https://github.com/acme/site/actions/runs/99')
  expect(await fix('release')).toMatchObject({ code: 2, stdout: expect.stringContaining('no pull request of this ticket waits to be released') })
})

it('releases a pull request a person merged on GitHub when asked, finds a release already shipped, and retries with the tag it made', async () => {
  expect(await (async () => { await ready(); return fix('release') })()).toMatchObject({ code: 2, stdout: expect.stringContaining('is not released by oncall-fix') })
  withReleases()
  expect(await fix('release')).toMatchObject({ code: 0 })
  expect(sessions.get('ses_3')!.input).toContain(`git merge-base --is-ancestor ${'f'.repeat(40)} origin/main`)
  finish('ses_3', answer('Already in v0.2.10.\n{"already_released": "v0.2.10"}')); await tick()
  expect(stage()).toMatchObject({ stage: 'released', release_tag: 'v0.2.10' })
  expect(replies().at(-1)).toContain('**已上线**：合并已包含在 v0.2.10 中')

  rmSync(join(root, 'state.json'))
  await ready()
  await fix('release', '--by', 'ou_carol')
  finish(stage().release_session, answer('github_dispatch_workflow refused: app_permission_not_granted.'), tagged('v0.2.11')); await tick()
  expect(stage()).toMatchObject({ stage: 'merged', release_tag: 'v0.2.11' })
  expect(replies().at(-1)).toMatch(/^<at user_id="ou_carol"><\/at> \*\*没有发布\*\*：github_dispatch_workflow refused/)
  expect(replies().at(-1)).toContain('已打 tag v0.2.11，重试会直接用它触发部署。')
  expect(await fix('release')).toMatchObject({ code: 0 })
  const second = stage().release_session
  const retry = sessions.get(second)!.input
  expect(retry).toContain(`already created tag v0.2.11 on ${MAIN}`)
  expect(retry).not.toContain('github_create_tag')
  // A run from before this release is not its run: the Session ended without one, so a person looks.
  finish(second, answer('Gave up waiting.'), runOf('5', 'success', '2000-01-01T00:00:00Z'), dispatched(null)); await tick()
  expect(stage()).toMatchObject({ stage: 'release_failed', reason: 'deploy run: 没有等到结果' })
  expect(replies().at(-1)).toContain('**发布 v0.2.11 未成功**（没有等到结果）')

  rmSync(join(root, 'state.json'))
  await ready(); await fix('release')
  finish(stage().release_session, answer('Deploy failed.'), runOf('6', 'failure'), dispatched('6'), tagged('v0.2.12')); await tick()
  expect(stage()).toMatchObject({ stage: 'release_failed', run_url: 'https://github.com/acme/site/actions/runs/6' })
  expect(replies().at(-1)).toMatch(/^\*\*发布 v0\.2\.12 未成功\*\*（failure）/)
})

it('refuses a bad REPOSITORIES or RELEASES entry, and a release of a repository without a clone', async () => {
  const base = readFileSync(join(root, 'fix.env'), 'utf8')
  const write = (extra: string) => writeFileSync(join(root, 'fix.env'), base + extra, { mode: 0o600 })
  write('REPOSITORIES=acme/site\n')
  expect(await tick()).toMatchObject({ code: 2, stderr: expect.stringContaining('owner/name@repository_id') })
  write('REPOSITORIES=acme/site@4242\nRELEASES=acme/site:deploy.yaml\n')
  expect(await tick()).toMatchObject({ code: 2, stderr: expect.stringContaining('owner/name:.github/workflows/file.yaml') })
  write('RELEASES=acme/other:.github/workflows/deploy.yaml\n')
  expect(await tick()).toMatchObject({ code: 2, stderr: expect.stringContaining('which REPOSITORIES does not list') })
})

it('refuses a request for a repository REPOSITORIES does not list, before starting a Session', async () => {
  expect(await fix('submit', '--repository', 'acme/other', '--brief', join(root, 'brief.md')))
    .toMatchObject({ code: 2, stderr: expect.stringContaining('acme/other is not in REPOSITORIES') })
  expect(sessions.size).toBe(0)
  await fix('submit', '--repository', 'acme/site', '--brief', join(root, 'brief.md'))
  expect([...sessions.values()][0]!.workspace).toEqual({ repository_id: '4242' })
})
