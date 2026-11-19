/** Tests for scripts/oncall-health against a stub service script and a stub lark-cli. */
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

let root: string
/**
 * The stub service answers `status` with the next line of `status-codes` (the last one repeats) and the JSON for that code,
 * records every call in `calls.log`, and reports `manually_stopped` when `stopped` exists.
 */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oncall health '))
  mkdirSync(join(root, 'scripts'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'oncall-health'), join(root, 'scripts', 'oncall-health'))
  writeFileSync(join(root, 'scripts', 'dsh-superagent'), `#!/usr/bin/env python3
import json, pathlib, sys
root = pathlib.Path(${JSON.stringify(root)})
args = [a for a in sys.argv[1:] if a not in ('--profile', 'oncall', '--url', 'http://127.0.0.1:3182')]
with (root / 'calls.log').open('a') as log: log.write(' '.join(args) + '\\n')
if args[-1] != 'status': sys.exit(int((root / 'restart-code').read_text()) if (root / 'restart-code').exists() else 0)
codes = (root / 'status-codes').read_text().split()
code = int(codes[0]); (root / 'status-codes').write_text(' '.join(codes[1:] or codes))
errors = {'history': 'read failed: 403'} if code == 2 else {}
print(json.dumps({'pids': [] if code == 1 else [1], 'manually_stopped': (root / 'stopped').exists(), 'errors': errors,
                  'setup': {'detail': 'Feishu bot CLI missing'} if code == 3 else None}))
sys.exit(code)
`, { mode: 0o755 })
  writeFileSync(join(root, 'lark'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(root, 'sends.log'))}\ncat health.md >> ${JSON.stringify(join(root, 'sent.md'))}; echo '---' >> ${JSON.stringify(join(root, 'sent.md'))}\n`, { mode: 0o755 })
  chmodSync(join(root, 'scripts', 'oncall-health'), 0o755)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function check(...extra: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', [join(root, 'scripts', 'oncall-health'), '--profile', 'oncall', '--url', 'http://127.0.0.1:3182',
    '--chat', 'oc_ops', '--lark-cli', join(root, 'lark'), '--state', join(root, 'state.json'), ...extra], { timeout: 30_000 },
  (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const sent = () => existsSync(join(root, 'sent.md')) ? readFileSync(join(root, 'sent.md'), 'utf8').split('---\n').filter(Boolean) : []
const calls = () => readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n')

it('says nothing while the service is healthy', async () => {
  writeFileSync(join(root, 'status-codes'), '0')
  expect(await check()).toMatchObject({ code: 0 })
  expect(sent()).toEqual([])
  expect(calls()).toEqual(['status'])
})

it('posts a part\'s error from its second failing check, not again within the repeat window, and its recovery once', async () => {
  writeFileSync(join(root, 'status-codes'), '2')
  expect(await check()).toMatchObject({ code: 0, stdout: expect.not.stringContaining('posted') })
  expect(sent()).toEqual([])
  expect((await check()).code).toBe(0)
  expect(await check()).toMatchObject({ code: 0, stdout: expect.not.stringContaining('posted') })
  expect(sent()).toHaveLength(1)
  expect(sent()[0]).toContain('有部分报错，重启修不好')
  expect(sent()[0]).toContain('- `history`: read failed: 403')
  // A restart does not fix a part's error, so none was tried.
  expect(calls()).toEqual(['status', 'status', 'status'])
  writeFileSync(join(root, 'status-codes'), '0')
  await check(); await check()
  expect(sent()).toHaveLength(2)
  expect(sent()[1]).toContain('已恢复正常')
  expect(readFileSync(join(root, 'sends.log'), 'utf8').split('\n')[0]).toBe('im +messages-send --chat-id oc_ops --markdown @health.md --as bot')
})

it('says nothing about a part\'s error that the next check no longer reports', async () => {
  writeFileSync(join(root, 'status-codes'), '2 0 2 0')
  for (let i = 0; i < 4; i++) await check()
  expect(sent()).toEqual([])
})

it('posts the same problem again after the repeat window', async () => {
  writeFileSync(join(root, 'status-codes'), '3')
  await check()
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')),
    at: new Date(Date.now() - 7 * 3600_000).toISOString() }))
  await check()
  expect(sent()).toHaveLength(2)
  expect(sent()[1]).toContain('等待设置：Feishu bot CLI missing')
})

it('restarts a service that is down and says it came back, or that it did not', async () => {
  writeFileSync(join(root, 'status-codes'), '1 0')
  await check()
  expect(calls()).toEqual(['status', '--respect-stop restart', 'status'])
  expect(sent()).toEqual([expect.stringContaining('已自动重启并恢复正常')])
  writeFileSync(join(root, 'status-codes'), '1'); writeFileSync(join(root, 'restart-code'), '1')
  await check()
  expect(sent()[1]).toContain('自动重启没有恢复')
})

it('leaves a service a person stopped alone, and changes nothing on a dry run', async () => {
  writeFileSync(join(root, 'status-codes'), '1'); writeFileSync(join(root, 'stopped'), '')
  await check()
  expect(calls()).toEqual(['status'])
  expect(sent()).toEqual([])
  rmSync(join(root, 'stopped'))
  const dry = await check('--dry-run')
  expect(dry.stdout).toContain('would run: dsh-superagent --respect-stop restart')
  expect(calls()).toEqual(['status', 'status'])
  expect(sent()).toEqual([])
})

it('refuses a bad chat before checking anything', async () => {
  expect(await check('--chat', 'nope')).toMatchObject({ code: 2, stderr: expect.stringContaining('--chat must be') })
  expect(existsSync(join(root, 'calls.log'))).toBe(false)
})
