/** Tests for scripts/dsh-superagent-deploy in a temporary checkout with a bare origin, a stub pnpm and a stub service script. */
import { execFileSync, execFile } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
/** The stub service: exits with the code in `restart-code` (default 0) for restart, records every call in `service.log`. */
function stubService() {
  writeFileSync(join(work, 'scripts', 'dsh-superagent'), `#!/usr/bin/env python3
import sys, pathlib
root = pathlib.Path(${JSON.stringify(root)})
with (root / 'service.log').open('a') as log: log.write(' '.join(sys.argv[1:2]) + ' ' + (pathlib.Path.cwd() / 'BUILT').read_text().strip() + '\\n') if (pathlib.Path.cwd() / 'BUILT').exists() else None
sql = root / (sys.argv[1] + '-sql')
if sql.exists():
    import sqlite3
    with sqlite3.connect(${JSON.stringify(join(state, 'orchestrator.sqlite'))}) as db: db.execute(sql.read_text())
code = root / (sys.argv[1] + '-code')
sys.exit(int(code.read_text()) if code.exists() else 0)
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

function deploy(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', [join(work, 'scripts', 'dsh-superagent-deploy'), '--state-dir', state, '--profile', 'oncall', ...args],
    { cwd: work, env: env(), timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const head = () => git(work, 'rev-parse', 'HEAD')
const built = () => readFileSync(join(work, 'BUILT'), 'utf8').trim()
const deployLog = () => readFileSync(join(root, 'deploy.log'), 'utf8')
const rows = () => { const db = new DatabaseSync(join(state, 'orchestrator.sqlite')); const v = db.prepare('select v from t').all(); db.close(); return v }

it('builds the tip of origin/main, backs up the database, restarts, and logs the commit', async () => {
  const v1 = commit('VERSION', 'v1'); git(work, 'checkout', '-q', '--detach', v1); writeFileSync(join(work, 'BUILT'), 'v1')
  const v2 = commit('VERSION', 'v2'); git(work, 'checkout', '-q', '--detach', v1)
  const result = await deploy()
  expect(result.code, result.stderr).toBe(0)
  expect(head()).toBe(v2)
  expect(built()).toBe('v2')
  expect(readFileSync(join(root, 'service.log'), 'utf8')).toBe('restart v2\n')
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

it('keeps the running service when the build fails, and returns to the previous commit', async () => {
  const v1 = commit('VERSION', 'v1'); git(work, 'checkout', '-q', '--detach', v1); writeFileSync(join(work, 'BUILT'), 'v1')
  const bad = commit('VERSION', 'broken'); git(work, 'checkout', '-q', '--detach', v1)
  const result = await deploy()
  expect(result.code).toBe(1)
  expect(head()).toBe(v1)
  expect(built()).toBe('v1')
  expect(existsSync(join(root, 'service.log'))).toBe(false)
  expect(deployLog()).toContain(`${bad.slice(0, 7)} FAILED build; kept ${v1.slice(0, 7)} running`)
})

it('rolls back the code and the database when the restart is unhealthy', async () => {
  const v1 = commit('VERSION', 'v1'); git(work, 'checkout', '-q', '--detach', v1); writeFileSync(join(work, 'BUILT'), 'v1')
  const v2 = commit('VERSION', 'v2'); git(work, 'checkout', '-q', '--detach', v1)
  writeFileSync(join(root, 'restart-code'), '1')
  // The new service migrates the database during its restart, then turns out unhealthy; the rollback restores the backup.
  writeFileSync(join(root, 'restart-sql'), "insert into t values ('v2')")
  const result = await deploy()
  expect(result.code, `${result.stdout}\n${result.stderr}\n${existsSync(join(root, 'deploy.log')) ? deployLog() : ''}`).toBe(1)
  expect(head()).toBe(v1)
  expect(built()).toBe('v1')
  expect(readFileSync(join(root, 'service.log'), 'utf8')).toBe('restart v2\nstop v2\nstart v1\n')
  expect(rows()).toEqual([{ v: 'v1' }])
  expect(deployLog()).toContain(`${v2.slice(0, 7)} FAILED restart (1); rolled back to ${v1.slice(0, 7)}`)
})

it('exits 3 when the rolled-back service does not come up either', async () => {
  const v1 = commit('VERSION', 'v1'); git(work, 'checkout', '-q', '--detach', v1); writeFileSync(join(work, 'BUILT'), 'v1')
  commit('VERSION', 'v2'); git(work, 'checkout', '-q', '--detach', v1)
  writeFileSync(join(root, 'restart-code'), '1'); writeFileSync(join(root, 'start-code'), '1')
  expect((await deploy()).code).toBe(3)
  expect(deployLog()).toContain('but it exits 1')
})
