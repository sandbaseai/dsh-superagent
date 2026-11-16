/** Tests for scripts/dsh-superagent-deploy in a temporary checkout with a bare origin, a stub pnpm and a stub service script. */
import { execFileSync, execFile } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { gitEnv } from './fixtures/git.ts'

let root: string, work: string, origin: string, state: string, bin: string
const env = () => gitEnv({ PATH: `${bin}:${process.env.PATH}`, HOME: root, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t' })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' }).trim()
/** Commit `file` with `text` on main and push it; returns the commit. */
function commit(file: string, text: string): string {
  writeFileSync(join(work, file), text)
  git(work, 'add', file); git(work, 'commit', '-q', '-m', `set ${file}`); git(work, 'push', '-q', 'origin', 'HEAD:main')
  return git(work, 'rev-parse', 'HEAD')
}
/**
 * The stub service records every call with the build it runs in `service.log`. For an action it exits with the code in
 * `<action>-<build>-code` or `<action>-code` (default 0), and first runs the SQL in `<action>-<build>-sql` on the database.
 */
function stubService() {
  writeFileSync(join(work, 'scripts', 'dsh-superagent'), `#!/usr/bin/env python3
import sys, pathlib
root = pathlib.Path(${JSON.stringify(root)})
action = sys.argv[1]
built = (pathlib.Path.cwd() / 'BUILT').read_text().strip() if (pathlib.Path.cwd() / 'BUILT').exists() else ''
with (root / 'service.log').open('a') as log: log.write(action + ' ' + built + '\\n')
sql = root / (action + '-' + built + '-sql')
if sql.exists():
    import sqlite3
    with sqlite3.connect(${JSON.stringify(join(state, 'orchestrator.sqlite'))}) as db: db.executescript(sql.read_text())
codes = [root / (action + '-' + built + '-code'), root / (action + '-code')]
code = next((path for path in codes if path.exists()), None)
sys.exit(int(code.read_text()) if code else 0)
`, { mode: 0o755 })
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deploy script '))
  origin = join(root, 'origin.git'); work = join(root, 'work'); state = join(root, 'state'); bin = join(root, 'bin')
  mkdirSync(bin); mkdirSync(state)
  // pnpm stub: `build` writes the checked-out commit's VERSION into BUILT, and fails when VERSION says so.
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh
[ "$1" = build ] || exit 0
grep -q broken VERSION && { echo 'build error' >&2; exit 1; }
cp VERSION BUILT
`, { mode: 0o755 })
  // The deploy script refuses to start unless the service script's own tools are on PATH.
  for (const name of ['dsh', 'tmux']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, work)
  mkdirSync(join(work, 'scripts'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent-deploy'), join(work, 'scripts', 'dsh-superagent-deploy'))
  chmodSync(join(work, 'scripts', 'dsh-superagent-deploy'), 0o755)
  stubService()
  writeFileSync(join(work, '.gitignore'), 'BUILT\n')
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'scripts'); git(work, 'push', '-q', 'origin', 'HEAD:main')
  const db = new DatabaseSync(join(state, 'orchestrator.sqlite')); db.exec('create table t (v text); insert into t values (\'v1\')'); db.close()
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** Run the deploy script; a leading object overrides environment variables (such as PATH) for this run. */
function deploy(...args: (string | Record<string, string>)[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const extra = typeof args[0] === 'object' ? args.shift() as Record<string, string> : {}
  return new Promise(resolve => execFile('python3', [join(work, 'scripts', 'dsh-superagent-deploy'), '--state-dir', state, '--profile', 'oncall', ...args as string[]],
    { cwd: work, env: { ...env(), ...extra }, timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const head = () => git(work, 'rev-parse', 'HEAD')
const built = () => readFileSync(join(work, 'BUILT'), 'utf8').trim()
const deployLog = () => readFileSync(join(root, 'deploy.log'), 'utf8')
const rows = () => { const db = new DatabaseSync(join(state, 'orchestrator.sqlite')); const v = db.prepare('select v from t').all(); db.close(); return v }

it('builds the tip of origin/main in a worktree, stops the service, backs up the database, starts the new build, and logs it', async () => {
  const v1 = commit('VERSION', 'v1'); git(work, 'checkout', '-q', '--detach', v1); writeFileSync(join(work, 'BUILT'), 'v1')
  const v2 = commit('VERSION', 'v2'); git(work, 'checkout', '-q', '--detach', v1)
  const result = await deploy()
  expect(result.code, result.stderr).toBe(0)
  expect(head()).toBe(v2)
  expect(built()).toBe('v2')
  expect(readFileSync(join(root, 'service.log'), 'utf8')).toBe('stop v1\nstart v2\n')
  expect(git(work, 'worktree', 'list').split('\n')).toHaveLength(1)
  expect(readdirSync(join(root, 'backups')).filter(name => name.endsWith('.sqlite'))).toHaveLength(1)
  expect(deployLog()).toMatch(new RegExp(`${v2.slice(0, 7)} set VERSION deployed \\(was ${v1.slice(0, 7)}\\)`))
})

it('does nothing when the target is already deployed, and changes nothing on a dry run', async () => {
  const v1 = commit('VERSION', 'v1')
  expect(await deploy()).toMatchObject({ code: 0, stdout: expect.stringContaining('already deployed') })
  commit('VERSION', 'v2'); git(work, 'checkout', '-q', '--detach', v1)
  expect(await deploy('--dry-run')).toMatchObject({ code: 0, stdout: expect.stringContaining('dry run') })
  expect(head()).toBe(v1)
  expect(existsSync(join(root, 'service.log'))).toBe(false)
})

it('refuses an unmerged commit, an unknown ref, and a checkout with uncommitted changes, before any change', async () => {
  const v1 = commit('VERSION', 'v1')
  git(work, 'checkout', '-q', '-b', 'side'); writeFileSync(join(work, 'VERSION'), 'side'); git(work, 'commit', '-q', '-am', 'side')
  const side = head(); git(work, 'checkout', '-q', '--detach', v1)
  expect(await deploy(side)).toMatchObject({ code: 2, stderr: expect.stringContaining('is not on origin/main') })
  expect(await deploy('no-such-ref')).toMatchObject({ code: 2, stderr: expect.stringContaining('unknown commit') })
  writeFileSync(join(work, 'VERSION'), 'edited')
  expect(await deploy()).toMatchObject({ code: 2, stderr: expect.stringContaining('uncommitted changes') })
  expect(existsSync(join(root, 'service.log'))).toBe(false)
})

it('refuses before any change when an untracked file is where the target adds one', async () => {
  const v1 = commit('VERSION', 'v1')
  commit('NEW', 'tracked in v2'); git(work, 'checkout', '-q', '--detach', v1)
  writeFileSync(join(work, 'NEW'), 'a local copy')
  expect(await deploy()).toMatchObject({ code: 2, stderr: expect.stringContaining('untracked files would be overwritten by the target commit: NEW') })
  expect(head()).toBe(v1)
  expect(existsSync(join(root, 'service.log'))).toBe(false)
  expect(existsSync(join(root, 'deploy.log'))).toBe(false)
})

it('refuses before any change when dsh or tmux is not on PATH, so the service is never stopped', async () => {
  const v1 = commit('VERSION', 'v1')
  commit('VERSION', 'v2'); git(work, 'checkout', '-q', '--detach', v1)
  // Only git, python3 and pnpm: what a non-login ssh shell without ~/.local/bin would find.
  const bare = join(root, 'bare-bin'); mkdirSync(bare)
  for (const name of ['git', 'python3']) symlinkSync(execFileSync('which', [name], { encoding: 'utf8' }).trim(), join(bare, name))
  symlinkSync(join(bin, 'pnpm'), join(bare, 'pnpm'))
  const result = await deploy({ PATH: bare })
  expect(result).toMatchObject({ code: 2, stderr: expect.stringContaining('dsh, tmux not found on PATH') })
  expect(head()).toBe(v1)
  expect(existsSync(join(root, 'service.log'))).toBe(false)
  expect(existsSync(join(root, 'deploy.log'))).toBe(false)
})

it('keeps the running service when the build fails, and returns to the previous commit', async () => {
  const v1 = commit('VERSION', 'v1'); git(work, 'checkout', '-q', '--detach', v1); writeFileSync(join(work, 'BUILT'), 'v1')
  const bad = commit('VERSION', 'broken'); git(work, 'checkout', '-q', '--detach', v1)
  const result = await deploy()
  expect(result.code).toBe(1)
  expect(head()).toBe(v1)
  expect(built()).toBe('v1')
  expect(existsSync(join(root, 'service.log'))).toBe(false)
  expect(deployLog()).toContain(`${bad.slice(0, 7)} FAILED build; kept ${v1.slice(0, 7)} running`)
  expect(git(work, 'worktree', 'list').split('\n')).toHaveLength(1)
})

it('rolls back the code and keeps the database when the new build starts unhealthy without changing its schema', async () => {
  const v1 = commit('VERSION', 'v1'); git(work, 'checkout', '-q', '--detach', v1); writeFileSync(join(work, 'BUILT'), 'v1')
  const v2 = commit('VERSION', 'v2'); git(work, 'checkout', '-q', '--detach', v1)
  writeFileSync(join(root, 'start-v2-code'), '1')
  // What the new build recorded before it turned out unhealthy, such as the receipt of a message it sent, stays.
  writeFileSync(join(root, 'start-v2-sql'), "insert into t values ('v2')")
  const result = await deploy()
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1)
  expect(head()).toBe(v1)
  expect(built()).toBe('v1')
  expect(readFileSync(join(root, 'service.log'), 'utf8')).toBe('stop v1\nstart v2\nstop v2\nstart v1\n')
  expect(rows()).toEqual([{ v: 'v1' }, { v: 'v2' }])
  expect(deployLog()).toContain(`${v2.slice(0, 7)} FAILED start (1); rolled back to ${v1.slice(0, 7)}`)
})

it('restores the database backup when the unhealthy new build changed the schema', async () => {
  const v1 = commit('VERSION', 'v1'); git(work, 'checkout', '-q', '--detach', v1); writeFileSync(join(work, 'BUILT'), 'v1')
  commit('VERSION', 'v2'); git(work, 'checkout', '-q', '--detach', v1)
  writeFileSync(join(root, 'start-v2-code'), '1')
  writeFileSync(join(root, 'start-v2-sql'), "create table kv (key text, value); insert into kv values ('schema', 12); insert into t values ('v2')")
  const result = await deploy()
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1)
  expect(result.stdout).toContain('the failed version changed its schema')
  expect(rows()).toEqual([{ v: 'v1' }])
})

it('starts the previous version again and changes nothing when the service does not stop', async () => {
  const v1 = commit('VERSION', 'v1'); git(work, 'checkout', '-q', '--detach', v1); writeFileSync(join(work, 'BUILT'), 'v1')
  commit('VERSION', 'v2'); git(work, 'checkout', '-q', '--detach', v1)
  writeFileSync(join(root, 'stop-code'), '1')
  expect((await deploy()).code).toBe(1)
  expect(head()).toBe(v1)
  expect(readFileSync(join(root, 'service.log'), 'utf8')).toBe('stop v1\nstart v1\n')
  expect(deployLog()).toContain('the service did not stop')
})

it('exits 3 when the rolled-back service does not come up either', async () => {
  const v1 = commit('VERSION', 'v1'); git(work, 'checkout', '-q', '--detach', v1); writeFileSync(join(work, 'BUILT'), 'v1')
  commit('VERSION', 'v2'); git(work, 'checkout', '-q', '--detach', v1)
  writeFileSync(join(root, 'start-code'), '1')
  expect((await deploy()).code).toBe(3)
  expect(deployLog()).toContain('but it exits 1')
})
