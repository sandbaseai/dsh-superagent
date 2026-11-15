/** Tests for scripts/oncall-digest with a stub dsh-oncall that answers Prometheus queries and a stub lark-cli that records sends. */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'oncall-digest')
let root: string

/** Per-provider 24 h totals now and a week earlier, and failures, as the stub answers them. */
const NOW = { 'provider-a': 10_000, 'provider-b': 6_000, 'provider-c': 4_000, tiny: 50 }
const BEFORE = { 'provider-a': 16_000, 'provider-b': 3_500, 'provider-c': 500, tiny: 40 }
const FAILED_NOW = { 'provider-a': 2_000, 'provider-b': 60 }
const FAILED_BEFORE = { 'provider-a': 160, 'provider-b': 35 }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oncall digest '))
  const vector = (values: Record<string, number>) => JSON.stringify({ result: Object.entries(values)
    .map(([provider, value]) => ({ metric: { provider }, value: [0, String(value)] })) })
  // The stub picks its answer from the query text: failed or not, a week back or not, range or instant.
  writeFileSync(join(root, 'dsh-oncall'), `#!/usr/bin/env python3
import sys, json
args = sys.argv[1:]
open(${JSON.stringify(join(root, 'queries.log'))}, 'a').write(json.dumps(args) + '\\n')
query = args[args.index('--query') + 1]
if args[3] == 'range':
    print(json.dumps({'result': [{'metric': {'provider': 'provider-a'}, 'values': [[1, '5'], [2, '6']]}]}))
elif 'ttft' in query:
    print(json.dumps({'result': []}))
elif 'failed' in query:
    print(${JSON.stringify(vector(FAILED_BEFORE))} if 'offset' in query else ${JSON.stringify(vector(FAILED_NOW))})
else:
    print(${JSON.stringify(vector(BEFORE))} if 'offset' in query else ${JSON.stringify(vector(NOW))})
`, { mode: 0o755 })
  writeFileSync(join(root, 'lark'), `#!/bin/sh
echo "$@" >> ${JSON.stringify(join(root, 'sends.log'))}
`, { mode: 0o755 })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ chat: 'oc_digest', envs: [{ env: 'prod-a', label: 'Region A' }],
    metrics: { requests: 'requests_total', provider: 'provider', status: 'status', failed: 'failed', ttft: 'ttft_seconds_bucket' } }))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function digest(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', [SCRIPT, '--config', join(root, 'config.json'), '--dsh-oncall', join(root, 'dsh-oncall'),
    '--lark-cli', join(root, 'lark'), '--out', join(root, 'out'), '--no-charts', '--now', '1794700800', ...args],
  { timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}

it('lists failures first, then traffic moves, leaves out providers below the share floor, and names the shift', async () => {
  const result = await digest('--dry-run')
  expect(result.code, result.stderr).toBe(0)
  const lines = result.stdout.split('\n').filter(line => line.startsWith('- '))
  expect(lines[0]).toBe('- **provider-a** 成功率下降：99.0% → 80.0%（10,000 次请求）')
  expect(lines.slice(1)).toEqual([
    '- **provider-a** 流量下降：16,000 → 10,000 次（-38%），占比 79.8% → 49.9%',
    '- **provider-c** 流量上升：500 → 4,000 次（+700%），占比 2.5% → 20.0%',
    '- **provider-b** 流量上升：3,500 → 6,000 次（+71%），占比 17.5% → 29.9%',
    '- 流量从 provider-a 转到 provider-c、provider-b，可能是路由或 failover 的变化',
  ])
  expect(result.stdout).not.toContain('tiny')
  expect(result.stdout).toContain('**Region A**：24 小时 20,050 次请求（7 天前 20,040，+0%）')
  // Only instant and range queries through dsh-oncall prom, against the configured environment.
  const queries = readFileSync(join(root, 'queries.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(new Set(queries.map(args => args.slice(0, 4).join(' ')))).toEqual(new Set(['prom --env prod-a query', 'prom --env prod-a range']))
})

it('posts the text to the configured chat, or to --chat for a test', async () => {
  expect((await digest()).code).toBe(0)
  expect((await digest('--chat', 'oc_test')).code).toBe(0)
  const sends = readFileSync(join(root, 'sends.log'), 'utf8').trim().split('\n')
  expect(sends).toEqual(['im +messages-send --chat-id oc_digest --markdown @digest.md --as bot', 'im +messages-send --chat-id oc_test --markdown @digest.md --as bot'])
  expect(readFileSync(join(root, 'out', 'digest.md'), 'utf8')).toContain('**渠道日报')
})

it('refuses a bad config or chat before any query', async () => {
  writeFileSync(join(root, 'config.json'), JSON.stringify({ chat: 'not-a-chat', envs: [{ env: 'prod-a' }], metrics: {} }))
  expect(await digest('--dry-run')).toMatchObject({ code: 2, stderr: expect.stringContaining('chat must be a Feishu chat id') })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ chat: 'oc_x', envs: [{ env: 'prod-a' }],
    metrics: { requests: 'requests_total) or vector(1', provider: 'provider', status: 'status', failed: 'failed' } }))
  expect(await digest('--dry-run')).toMatchObject({ code: 2, stderr: expect.stringContaining('metrics.requests') })
  expect(() => readFileSync(join(root, 'queries.log'))).toThrow()
})
