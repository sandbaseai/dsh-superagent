/** The Feishu on-call kit in examples/feishu-cls-oncall against the real schemas, and scripts/oncall-apply against a fake Management API. */
import { execFile } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Prompts, builtInBase, builtInParts, composeSkill, type PromptConfig } from '../src/app/prompts.ts'
import { Store } from '../src/app/store.ts'
import { LIMITS } from '../src/limits.ts'
import { EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'

const ROOT = join(import.meta.dirname, '..')
const KIT = join(ROOT, 'examples', 'feishu-cls-oncall')
const SCRIPT = join(ROOT, 'scripts', 'oncall-apply')
const MODELS = ['--router-model', 'claude-sonnet-5-5', '--worker-model', 'claude-opus-5-5']
const ARGS = ['--lark-cli', '/home/oncall/.local/bin/lark-bot', '--alert-chat', 'oc_alerts1,oc_alerts2', '--alert-bot', 'cli_clsalarm', ...MODELS]
let server: Server | undefined
let temporary: string[] = []
afterEach(() => {
  server?.close(); server = undefined
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
  temporary = []
})
const scratch = (prefix: string) => { const path = mkdtempSync(join(tmpdir(), prefix)); temporary.push(path); return path }
function apply(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', [SCRIPT, ...args], { timeout: 30_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
/** The requests a dry run prints, by `<method> <path>`, in order. */
function requests(stdout: string): [string, Record<string, unknown>][] {
  return stdout.split(/^--- /m).filter(Boolean).map(part => {
    const newline = part.indexOf('\n')
    return [part.slice(0, newline), JSON.parse(part.slice(newline + 1)) as Record<string, unknown>]
  })
}
async function dryRun() {
  const result = await apply('--dry-run', ...ARGS)
  expect(result).toMatchObject({ code: 0, stderr: '' })
  return requests(result.stdout)
}
const value = (body: Record<string, unknown>) => body.value as Record<string, unknown>

describe('the kit settings', () => {
  it('fill in as oncall-apply fills them and parse with the settings schemas, in save order', async () => {
    const bodies = await dryRun()
    expect(bodies.map(([request]) => request)).toEqual(['PUT settings/source:feishu', 'PUT settings/policy', 'PUT settings/eval', 'PUT settings/executor', 'PUT prompts'])
    const [feishu, policy, evaluation, executor] = bodies.map(([, body]) => value(body))
    expect(feishu).toMatchObject({ enabled: true })
    expect(feishuKind.schema.parse(feishu!.config)).toMatchObject({ cli: '/home/oncall/.local/bin/lark-bot', directMessages: false, otherChats: 'none',
      chats: [{ chatId: 'oc_alerts1', listen: 'all' }, { chatId: 'oc_alerts2', listen: 'all' }] })
    const rules = PolicyConfigSchema.parse(policy).rules
    // Only the alert rules, the fallback-page one disabled: the copy and visual defaults are not included.
    expect(rules.map(rule => [rule.id, rule.enabled])).toEqual([['tencent-alert', true], ['fallback-page', false]])
    for (const rule of rules) expect(rule.instruction.length).toBeLessThanOrEqual(LIMITS.ruleInstruction)
    const { admission, ...part } = (policy as { sources: { feishu: Record<string, unknown> } }).sources.feishu
    expect(admission).toEqual({})
    expect(feishuKind.policy!.schema.parse(part)).toEqual({ allowed: [], syncChat: '', bots: [{ id: 'cli_clsalarm', name: '腾讯云告警' }] })
    expect(EvalConfigSchema.parse(evaluation)).toEqual({ mode: 'observe', timeoutSeconds: 120, model: { provider: 'anthropic-gateway', model: 'claude-sonnet-5-5' } })
    expect(ExecutorConfigSchema.parse(executor)).toMatchObject({ model: { provider: 'anthropic-gateway', model: 'claude-opus-5-5' }, maxWorkers: 2,
      blockedCommands: expect.arrayContaining(['kubectl', 'curl', 'tccli']) })
  })

  it('takes the accept mode and models from the arguments', async () => {
    const result = await apply('--dry-run', ...ARGS.slice(0, 6), '--mode', 'auto', '--router-model', 'claude-opus-5-5', '--worker-model', 'claude-sonnet-5-5')
    const bodies = Object.fromEntries(requests(result.stdout))
    expect(value(bodies['PUT settings/eval']!)).toMatchObject({ mode: 'auto', model: { provider: 'anthropic-gateway', model: 'claude-opus-5-5' } })
    expect(value(bodies['PUT settings/executor']!)).toMatchObject({ model: { provider: 'anthropic-gateway', model: 'claude-sonnet-5-5' } })
  })

  it.each([['--router-model', MODELS.slice(2)], ['--worker-model', MODELS.slice(0, 2)]])('refuses without %s while the kit\'s model is a placeholder', async (flag, rest) => {
    const result = await apply('--dry-run', ...ARGS.slice(0, 6), ...rest)
    expect(result).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining(`pass ${flag}`) })
  })
})

describe('the kit prompts', () => {
  it('validate as a prompt configuration, register the oncall-alerts skill and give workers the read-only tools instead of PRs', async () => {
    const config = (await dryRun()).at(-1)![1].config as PromptConfig
    const dir = scratch('oncall-kit-')
    const store = new Store(join(dir, 'db'))
    try {
      const prompts = new Prompts(store, () => 100000, () => [], () => true, () => false)
      const valid = prompts.validate(config)
      expect(Object.keys(valid.overrides ?? {}).sort()).toEqual(['runtime/admission', 'runtime/work', 'runtime/worker'])
      expect(composeSkill(valid, 'oncall-alerts')).toBe(readFileSync(join(KIT, 'skills', 'oncall-alerts.md'), 'utf8').trimEnd())
      expect(prompts.skills(valid).map(([name]) => name)).toEqual(['feishu', 'oncall-alerts'])
      const worker = prompts.compose(valid, 'worker')
      expect(worker).toContain('`dsh-oncall` (envs, cls, prom, monitor, kube, grafana)')
      expect(worker).toContain('dsh-superagent-oncall-alerts')
      expect(worker).not.toContain('open a PR')
      expect(worker).not.toContain('pr create')
      // The overrides carry the base they were written against, which matches this version's built-in text.
      expect(prompts.defaultChanged(valid)).toEqual([])
    } finally { store.close() }
  })

  it('record the built-in text they were written against as their base', () => {
    // On an upgrade that changes one of these parts, diff the override against the new built-in text, then update bases.json.
    const bases = JSON.parse(readFileSync(join(KIT, 'overrides', 'bases.json'), 'utf8')) as Record<string, string>
    const parts = builtInParts()
    expect(bases).toEqual(Object.fromEntries((['runtime/admission', 'runtime/work', 'runtime/worker'] as const)
      .map(part => [part, builtInBase(parts[part].text)])))
  })

  it.each([['runtime/admission', 'runtime-admission.md'], ['runtime/work', 'runtime-work.md'], ['runtime/worker', 'runtime-worker.md']] as const)(
    'keep every tool-protocol name of the built-in %s', (part, file) => {
      const names = (text: string) => new Set(text.match(/\b(?:orchestrator_[a-z_]+|rule_assessments|reply_to_trigger_id|pr_number|worktree_name)\b/g))
      const builtIn = names(builtInParts()[part].text)
      expect(builtIn.size).toBeGreaterThan(0)
      expect([...builtIn].filter(name => !names(readFileSync(join(KIT, 'overrides', file), 'utf8')).has(name))).toEqual([])
    })
})

describe('the kit profile patch', () => {
  interface Row { id?: string; name?: string; disabled?: unknown; config?: unknown }
  it('turns Feishu on and GitHub off, adds the Anthropic-compatible route by credential reference only, and patches only entries that exist', async () => {
    const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
    const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
    const { entryListSchema, applyEntryPatches } = await import(include) as {
      entryListSchema: unknown; applyEntryPatches(data: Row[], patches: unknown[], warn: (message: string) => void): Row[] }
    const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
    const load = (path: string) => yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema }) as unknown[]
    const warnings: string[] = []
    const bundle = applyEntryPatches([], load(join(ROOT, 'cordis.patch.yml')), message => { warnings.push(message) })
    // The entries of the DeepSeek Harness 0.2.1-rc.3 Web template the kit patches, by id and plugin name.
    const template: Row[] = [{ id: 'webserver', name: '@deepseek-ai/dsh-host-webserver' }, { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
      { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } }]
    const text = readFileSync(join(KIT, 'profile.cordis.patch.yml'), 'utf8')
    const rows = applyEntryPatches([...template, ...bundle], load(join(KIT, 'profile.cordis.patch.yml')), message => { warnings.push(message) })
    expect(warnings).toEqual([])
    const row = (id: string) => rows.find(item => item.id === id)!
    expect(row('dsh-superagent-github').disabled).toBe(true)
    expect(row('dsh-superagent-feishu').disabled).toBe(false)
    expect(row('webserver').config).toEqual({ host: '127.0.0.1', port: 3082 })
    expect(row('llm-pi-ai').config).toEqual({ providers: { 'anthropic-gateway': { displayName: 'Anthropic-compatible gateway',
      api: 'anthropic-messages', baseURL: '<Anthropic-compatible base URL>', apiKeyEnv: 'ONCALL_LLM_API_KEY',
      models: [{ id: '<router model id>', name: 'Router' }, { id: '<worker model id>', name: 'Worker' }] } } })
    expect(row('agent-default-model').config).toEqual({ provider: 'anthropic-gateway', model: '<router model id>' })
    expect(text).toContain('apiKeyEnv')
    expect(text).not.toMatch(/sk-|apiKey:/)
    expect(text).not.toMatch(/sandbase|agrouter/i)
  })
})

describe('scripts/oncall-apply', () => {
  it('refuses a malformed chat id and a placeholder the kit still has, without a request', async () => {
    expect(await apply('--dry-run', ...ARGS.slice(0, 2), '--alert-chat', 'oc_ok,chat-2', '--alert-bot', 'cli_clsalarm'))
      .toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('--alert-chat chat-2 does not match') })
    expect(await apply('--dry-run', ...ARGS.slice(0, 4), '--alert-bot', 'bot_1')).toMatchObject({ code: 2, stderr: expect.stringContaining('--alert-bot bot_1') })
    const kit = join(scratch('oncall-kit-'), 'kit')
    cpSync(KIT, kit, { recursive: true })
    const executor = JSON.parse(readFileSync(join(kit, 'settings', 'executor.json'), 'utf8'))
    writeFileSync(join(kit, 'settings', 'executor.json'), JSON.stringify({ ...executor, directory: '<absolute work directory>' }))
    expect(await apply('--dry-run', '--kit', kit, ...ARGS)).toMatchObject({ code: 2, stdout: '',
      stderr: expect.stringContaining('the executor block still has placeholders: <absolute work directory>') })
  })

  it('saves the settings blocks in order with GET settings revisions, waits after a restarting save, then saves the prompts', async () => {
    const seen: { method: string; path: string; header: unknown; body?: Record<string, unknown> }[] = []
    let restarted = false, down = 0
    const revisionsNow = () => restarted ? { feishu: 12, policy: 13, eval: 14, executor: 15 } : { feishu: 2, policy: 3, eval: 4, executor: 5 }
    const read = (request: IncomingMessage) => new Promise<string>(resolve => { let text = ''; request.on('data', chunk => { text += chunk }); request.on('end', () => resolve(text)) })
    server = createServer(async (request, response) => {
      const path = request.url!.replace('/orchestrator/api/', '')
      const text = await read(request)
      seen.push({ method: request.method!, path, header: request.headers['x-orchestrator-request'], ...text ? { body: JSON.parse(text) } : {} })
      const reply = (status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      const revisions = revisionsNow()
      if (path === 'state') return down-- > 0 ? reply(503, { error: 'restarting' }) : reply(200, { health: {} })
      if (path === 'settings') {
        return reply(200, { blocks: { policy: { revision: revisions.policy }, eval: { revision: revisions.eval }, executor: { revision: revisions.executor } },
          sources: [{ id: 'github', installed: false, revision: 0 }, { id: 'feishu', installed: true, revision: revisions.feishu }] })
      }
      if (path === 'settings/source:feishu') { restarted = true; down = 1; return reply(200, { saved: true, revision: 3, restarting: true }) }
      if (path.startsWith('settings/')) return reply(200, { saved: true, revision: 99, restarting: false })
      if (path === 'prompts' && request.method === 'GET') return reply(200, { current: { revision: 7, config: {} } })
      if (path === 'prompts') return reply(200, { revision: 8 })
      return reply(404, { error: 'Not found' })
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const result = await apply('--url', url, ...ARGS)
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(result.stdout.trim().split('\n')).toEqual(['saved source:feishu revision 3 (restarting)', 'saved policy revision 99', 'saved eval revision 99',
      'saved executor revision 99', 'saved prompts revision 8'])
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual(['GET settings', 'PUT settings/source:feishu', 'GET state', 'GET state', 'GET settings',
      'PUT settings/policy', 'PUT settings/eval', 'PUT settings/executor', 'GET prompts', 'PUT prompts'])
    expect(seen.every(request => request.header === '1')).toBe(true)
    // The first save uses the revision read before the restart; the later ones those read after it.
    expect(seen.filter(request => request.method === 'PUT').map(request => request.body!.revision ?? request.body!.baseRevision)).toEqual([2, 13, 14, 15, 7])
    expect(seen.at(-1)!.body!.config).toMatchObject({ skills: { 'oncall-alerts': expect.any(String) }, overrides: { 'runtime/worker': { text: expect.any(String) } } })
    expect(seen.at(-1)!.body!.config).toHaveProperty(['overrides', 'runtime/worker', 'base'],
      JSON.parse(readFileSync(join(KIT, 'overrides', 'bases.json'), 'utf8'))['runtime/worker'])
  }, 20_000)

  it('stops with the server\'s error and setup text when a save is refused', async () => {
    server = createServer((request, response) => {
      const reply = (status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (request.url!.endsWith('/settings')) {
        return reply(200, { blocks: { policy: { revision: 1 }, eval: { revision: 1 }, executor: { revision: 1 } }, sources: [{ id: 'feishu', installed: true, revision: 1 }] })
      }
      return reply(400, { error: 'The account check failed', setup: { code: 'feishuCliFailed', detail: 'The bot lark-cli does not work.' } })
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const result = await apply('--url', `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...ARGS)
    expect(result).toMatchObject({ code: 1, stdout: '' })
    expect(result.stderr).toContain('PUT settings/source:feishu answered 400: The account check failed; setup: The bot lark-cli does not work.')
  })
})
