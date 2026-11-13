/** Tests for scripts/dsh-oncall against a temporary config directory, a stub kubectl and local CLS, Cloud Monitor, Prometheus and
 * Grafana servers. */
import { execFile } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'dsh-oncall')
const SECRET_ID = 'AKIDtestsecretid0001'
const SECRET_KEY = 'testsecretkey-value-0002'
const GRAFANA_TOKEN = 'glsa_testtoken_value_0003'
let root: string
let server: Server | undefined
interface Recorded { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }
let requests: Recorded[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oncall '))
  mkdirSync(join(root, 'config'), { mode: 0o700 }); mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'worker-bin'))
  // The stub kubectl records that it ran and prints its argv as JSON.
  writeFileSync(join(root, 'bin', 'kubectl'), `#!/usr/bin/env python3\nimport json, sys\nopen(${JSON.stringify(join(root, 'ran'))}, 'w').close()\n`
    + 'print(json.dumps(sys.argv[1:]))\n', { mode: 0o755 })
  writeFileSync(join(root, 'worker-bin', 'kubectl'), '#!/bin/sh\necho blocked shim >&2\nexit 9\n', { mode: 0o755 })
  requests = []
})
afterEach(() => {
  server?.close(); server = undefined
  rmSync(root, { recursive: true, force: true })
})

/** Write `<env>.env` with mode 0600 (or `mode`). */
function config(env: string, lines: string[], mode = 0o600) {
  const path = join(root, 'config', `${env}.env`)
  writeFileSync(path, `# on-call\n\n${lines.join('\n')}\n`)
  chmodSync(path, mode)
}
const kubeConfig = (extra: string[] = []) => config('prod', ['KUBECONFIG=/tmp/kubeconfig', 'KUBE_CONTEXT="prod-ctx"',
  'KUBE_NAMESPACE=apps', ...extra])
function run(args: string[], path = `${join(root, 'worker-bin')}:${join(root, 'bin')}:${process.env.PATH}`):
  Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', [SCRIPT, ...args],
    { env: { ...process.env, PATH: path, DSH_ONCALL_CONFIG_DIR: join(root, 'config') }, timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
/** Start a server that records every request and answers `answer`. */
async function serve(answer: unknown, status = 200): Promise<string> {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body })
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
const kube = async (...args: string[]) => {
  const result = await run(['kube', '--env', 'prod', ...args])
  return { ...result, argv: result.code === 0 ? JSON.parse(JSON.parse(result.stdout).stdout) as string[] : [] }
}

it('is executable', () => {
  expect(statSync(SCRIPT).mode & 0o111).not.toBe(0)
})
it('refuses a config file group or others can read, without printing it', async () => {
  config('prod', [`CLS_SECRET_ID=${SECRET_ID}`, `CLS_SECRET_KEY=${SECRET_KEY}`, 'CLS_REGION=ap-singapore'], 0o644)
  const result = await run(['cls', '--env', 'prod', '--query', 'error'])
  expect(result.code).toBe(2)
  expect(result.stderr).toMatch(/^refused: .*prod\.env must not be accessible/)
  expect(result.stdout + result.stderr).not.toContain(SECRET_KEY)
})
it('refuses an environment without a config file, and a malformed name', async () => {
  expect(await run(['kube', '--env', 'staging', 'get', 'pods'])).toMatchObject({ code: 2, stderr: expect.stringContaining('staging.env') })
  expect(await run(['kube', '--env', '../x', 'get', 'pods'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^refused:/) })
})
it('lists environments with their tool groups and no values', async () => {
  config('prod', [`CLS_SECRET_ID=${SECRET_ID}`, `CLS_SECRET_KEY='${SECRET_KEY}'`, 'CLS_REGION=ap-singapore', 'KUBECONFIG=/k',
    'KUBE_CONTEXT=c', 'KUBE_NAMESPACE=n', 'GRAFANA_BASE_URL=https://grafana.example', `GRAFANA_TOKEN=${GRAFANA_TOKEN}`])
  config('test', ['GRAFANA_BASE_URL=https://grafana.example', `GRAFANA_TOKEN=${GRAFANA_TOKEN}`])
  const result = await run(['envs'])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout).envs).toEqual([{ name: 'prod', tools: ['cls', 'kube', 'grafana'] }, { name: 'test', tools: ['grafana'] }])
  for (const secret of [SECRET_ID, SECRET_KEY, GRAFANA_TOKEN, 'grafana.example']) expect(result.stdout + result.stderr).not.toContain(secret)
})

it('injects the kubeconfig, context and namespace, and -A drops the namespace', async () => {
  kubeConfig([`KUBECTL=${join(root, 'bin', 'kubectl')}`])
  expect((await kube('get', 'pods')).argv).toEqual(['--kubeconfig', '/tmp/kubeconfig', '--context', 'prod-ctx', '-n', 'apps',
    '--request-timeout=30s', 'get', 'pods'])
  expect((await kube('get', 'pods', '-A')).argv).toEqual(['--kubeconfig', '/tmp/kubeconfig', '--context', 'prod-ctx',
    '--request-timeout=30s', 'get', 'pods', '-A'])
  expect((await kube('get', 'pods', '-n', 'other')).argv).not.toContain('apps')
})
it('adds log defaults and caps the tail', async () => {
  kubeConfig([`KUBECTL=${join(root, 'bin', 'kubectl')}`])
  expect((await kube('logs', 'api-1')).argv.slice(-3)).toEqual(['api-1', '--tail=200', '--since=1h'])
  expect((await kube('logs', 'api-1', '--tail', '99999', '--since-time=2026-11-11T00:00:00Z')).argv.slice(-2))
    .toEqual(['--tail=2000', '--since-time=2026-11-11T00:00:00Z'])
  expect((await kube('logs', 'api-1', '--tail=50', '--since=5m')).argv.slice(-2)).toEqual(['--tail=50', '--since=5m'])
})
it.each([
  ['delete', 'pods', 'x'], ['apply', '-f', 'x.yaml'], ['exec', 'api-1', '--', 'sh'], ['rollout', 'restart', 'deploy/api'],
  ['port-forward', 'api-1', '80'], ['get', 'pods', '--as', 'admin'], ['get', 'pods', '--kubeconfig=/other'], ['get', 'secrets'],
  ['get', 'secret/foo'], ['get', 'pods,Secrets.v1.'], ['describe', 'cm', 'x'], ['get', 'cm', '-o', 'yaml'], ['get', 'cm', '-ojson'],
  ['logs', '-f', 'api-1'], ['get', 'pods', '-w'], ['get', 'pods', '--raw=/api'], ['get', 'pods', '-s', 'https://x'],
  // Output formats and flags that read a local file and print it, or write one.
  ['get', 'pods', '-o', 'go-template-file=/tmp/other.env'], ['get', 'pods', '-ojsonpath-file=/tmp/x'], ['get', 'pods', '--output=templatefile=/tmp/x'],
  ['get', 'pods', '--output', 'custom-columns-file=/tmp/x'], ['get', 'pods', '-o', 'template', '--template=/tmp/x'],
  ['get', 'pods', '--template', '/tmp/x'], ['get', 'pods', '--profile=cpu', '--profile-output=/tmp/out'], ['get', 'pods', '--cache-dir=/tmp/c'],
  ['get', 'pods', '--client-key=/tmp/k'],
  // kubectl reads `_` in a long flag name as `-`; impersonation extras are refused too.
  ['get', 'pods', '--cache_dir=/tmp/c'], ['get', 'pods', '--insecure_skip_tls_verify'], ['get', 'pods', '--as_group=admins'],
  ['get', 'pods', '--as-user-extra=scopes=all'], ['get', 'pods', '--as_user_extra', 'scopes=all'],
])('refuses kubectl %s %s without running it', async (...args: string[]) => {
  kubeConfig([`KUBECTL=${join(root, 'bin', 'kubectl')}`])
  const result = await run(['kube', '--env', 'prod', ...args])
  expect(result).toMatchObject({ code: 2, stderr: expect.stringMatching(/^refused:/) })
  expect(existsSync(join(root, 'ran'))).toBe(false)
})
it('allows ConfigMap names, rollout status, auth can-i and inline templates', async () => {
  kubeConfig([`KUBECTL=${join(root, 'bin', 'kubectl')}`])
  for (const args of [['get', 'cm'], ['get', 'configmaps', '-o', 'name'], ['rollout', 'status', 'deploy/api'], ['auth', 'can-i', 'list', 'pods'],
    ['get', 'pods', '-o', 'go-template={{range .items}}{{.metadata.name}}{{end}}'], ['get', 'pods', '-o', 'jsonpath={.items[*].metadata.name}']])
    expect((await kube(...args)).code).toBe(0)
})
it('finds kubectl on PATH past the worker-bin shim directory', async () => {
  kubeConfig()
  const result = await kube('get', 'pods')
  expect(result.code).toBe(0)
  expect(result.argv).toContain('get')
})

/** Recompute the TC3-HMAC-SHA256 Authorization of a recorded Tencent Cloud API request for `service`. */
function tc3(request: Recorded, service = 'cls'): string {
  const timestamp = Number(request.headers['x-tc-timestamp'])
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
  const canonical = ['POST', '/', '', `content-type:${request.headers['content-type']}`, `host:${request.headers.host}`, '',
    'content-type;host', sha(request.body)].join('\n')
  const scope = `${date}/${service}/tc3_request`
  const toSign = ['TC3-HMAC-SHA256', String(timestamp), scope, sha(canonical)].join('\n')
  const mac = (key: string | Buffer, text: string) => createHmac('sha256', key).update(text, 'utf8').digest()
  const signing = mac(mac(mac(`TC3${SECRET_KEY}`, date), service), 'tc3_request')
  return `TC3-HMAC-SHA256 Credential=${SECRET_ID}/${scope}, SignedHeaders=content-type;host, `
    + `Signature=${createHmac('sha256', signing).update(toSign, 'utf8').digest('hex')}`
}
const clsConfig = (url: string) => config('prod', [`CLS_SECRET_ID=${SECRET_ID}`, `CLS_SECRET_KEY=${SECRET_KEY}`,
  'CLS_REGION=ap-singapore', 'CLS_TOPIC_ID=topic-default', 'CLS_TOPICS=api=topic-api,web=topic-web', `CLS_ENDPOINT=${url}`])

it('signs a SearchLog request and prints the parsed results', async () => {
  clsConfig(await serve({ Response: { RequestId: 'r1', ListOver: true, Analysis: false,
    Results: [{ Time: 1762800000000, Source: '10.0.0.1', LogJson: '{"level":"error","msg":"boom"}' },
      { Time: 1762800000001, Source: '10.0.0.2', LogJson: 'x'.repeat(5000) }] } }))
  const result = await run(['cls', '--env', 'prod', '--query', 'level:error', '--topic', 'api', '--from', '1762790000000',
    '--to', '2026-11-11T00:00:00Z', '--limit', '20', '--sort', 'asc'])
  expect(result.code).toBe(0)
  const request = requests[0]!
  expect(request).toMatchObject({ method: 'POST', url: '/' })
  expect(request.headers).toMatchObject({ 'x-tc-action': 'SearchLog', 'x-tc-version': '2020-10-16', 'x-tc-region': 'ap-singapore',
    'content-type': 'application/json; charset=utf-8' })
  expect(JSON.parse(request.body)).toEqual({ TopicId: 'topic-api', From: 1762790000000, To: Date.parse('2026-11-11T00:00:00Z'),
    Query: 'level:error', Limit: 20, Sort: 'asc', SyntaxRule: 1 })
  expect(request.headers.authorization).toBe(tc3(request))
  const output = JSON.parse(result.stdout)
  expect(output).toMatchObject({ topic: 'topic-api', count: 2, listOver: true,
    results: [{ time: 1762800000000, source: '10.0.0.1', content: { level: 'error', msg: 'boom' } }, { truncated: true }] })
  expect(output.results[1].content).toHaveLength(4000)
  expect(result.stdout + result.stderr).not.toContain(SECRET_KEY)
})
it('reports a CLS error without the secret', async () => {
  clsConfig(await serve({ Response: { RequestId: 'r2', Error: { Code: 'AuthFailure.SignatureFailure', Message: `bad key ${SECRET_KEY}` } } }))
  const result = await run(['cls', '--env', 'prod', '--query', 'error'])
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout).error).toEqual({ code: 'AuthFailure.SignatureFailure', message: 'bad key ***' })
  expect(result.stdout + result.stderr).not.toContain(SECRET_KEY)
  expect(JSON.parse(requests[0]!.body).TopicId).toBe('topic-default')
})
it('allows plain HTTP to CLS only on loopback', async () => {
  clsConfig('http://cls.example.com')
  expect(await run(['cls', '--env', 'prod', '--query', 'error'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^refused:/) })
})

const grafanaConfig = (url: string) => config('prod', [`GRAFANA_BASE_URL=${url}`, `GRAFANA_TOKEN=${GRAFANA_TOKEN}`])
it('GETs an allow-listed Grafana path with the bearer token and params', async () => {
  grafanaConfig(await serve({ status: 'success', data: { result: [] } }))
  const result = await run(['grafana', '--env', 'prod', '/api/datasources/proxy/uid/prom_1/api/v1/query', '--param', 'query=up{job="api"}',
    '--param', 'time=1762800000'])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ status: 200, body: { status: 'success', data: { result: [] } } })
  expect(requests).toHaveLength(1)
  expect(requests[0]!).toMatchObject({ method: 'GET', url: `/api/datasources/proxy/uid/prom_1/api/v1/query?query=${encodeURIComponent('up{job="api"}')
    .replace(/%20/g, '+')}&time=1762800000` })
  expect(requests[0]!.headers.authorization).toBe(`Bearer ${GRAFANA_TOKEN}`)
  expect(result.stdout + result.stderr).not.toContain(GRAFANA_TOKEN)
})
it('allows plain HTTP to Grafana only on loopback', async () => {
  grafanaConfig('http://grafana.example.com')
  const result = await run(['grafana', '--env', 'prod', '/api/health'])
  expect(result).toMatchObject({ code: 2, stderr: expect.stringContaining('GRAFANA_BASE_URL may use http:// only') })
  expect(result.stdout + result.stderr).not.toContain(GRAFANA_TOKEN)
})
it.each(['/api/dashboards/db', '/api/admin/users', '/api/datasources/1', '/api/datasources/proxy/uid/p/api/v1/../../admin',
  '/api/search?query=x'])('refuses Grafana path %s without a request', async path => {
  grafanaConfig(await serve({}))
  expect(await run(['grafana', '--env', 'prod', path])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^refused:/) })
  expect(requests).toHaveLength(0)
})

const PROM_TOKEN = 'prom_testtoken_value_0004'
const monitorConfig = (url: string) => config('prod', [`MONITOR_SECRET_ID=${SECRET_ID}`, `MONITOR_SECRET_KEY=${SECRET_KEY}`,
  'MONITOR_REGION=na-ashburn', `MONITOR_ENDPOINT=${url}`])
const monitorData = (span = 3600) => JSON.stringify({ Namespace: 'QCE/CDB', MetricName: 'MemoryUseRate', Period: 60,
  StartTime: new Date(Date.parse('2026-11-11T00:00:00Z') - span * 1000).toISOString(), EndTime: '2026-11-11T00:00:00Z',
  Instances: [{ Dimensions: [{ Name: 'InstanceId', Value: 'cdb-test0001' }] }] })

it('signs a GetMonitorData request with service monitor and prints the Response', async () => {
  monitorConfig(await serve({ Response: { RequestId: 'm1', Period: 60, MetricName: 'MemoryUseRate',
    DataPoints: [{ Dimensions: [{ Name: 'InstanceId', Value: 'cdb-test0001' }], Timestamps: [1, 2], Values: [91.5, 92] }] } }))
  const result = await run(['monitor', '--env', 'prod', '--action', 'GetMonitorData', '--params', monitorData(), '--region', 'ap-singapore'])
  expect(result.code).toBe(0)
  const request = requests[0]!
  expect(request).toMatchObject({ method: 'POST', url: '/' })
  expect(request.headers).toMatchObject({ 'x-tc-action': 'GetMonitorData', 'x-tc-version': '2018-07-24', 'x-tc-region': 'ap-singapore' })
  expect(JSON.parse(request.body)).toEqual(JSON.parse(monitorData()))
  expect(request.headers.authorization).toBe(tc3(request, 'monitor'))
  expect(JSON.parse(result.stdout)).toEqual({ action: 'GetMonitorData', region: 'ap-singapore', requestId: 'm1',
    response: { Period: 60, MetricName: 'MemoryUseRate', DataPoints: [{ Dimensions: [{ Name: 'InstanceId', Value: 'cdb-test0001' }],
      Timestamps: [1, 2], Values: [91.5, 92] }] } })
  expect(result.stdout + result.stderr).not.toContain(SECRET_KEY)
})
it('shrinks the largest list of a Monitor Response to fit the output limit', async () => {
  const histories = Array.from({ length: 3000 }, (_, index) => ({ AlarmId: `a${index}`, Content: 'x'.repeat(200) }))
  monitorConfig(await serve({ Response: { RequestId: 'm2', TotalCount: 3000, Histories: histories } }))
  const result = await run(['monitor', '--env', 'prod', '--action', 'DescribeAlarmHistories', '--params',
    JSON.stringify({ Module: 'monitor', PageSize: 100, StartTime: 1762800000, EndTime: 1762800000 + 3600 })])
  expect(result.code).toBe(0)
  const output = JSON.parse(result.stdout)
  expect(output.truncated).toBe(true)
  expect(output.response.TotalCount).toBe(3000)
  expect(output.response.Histories.length).toBeGreaterThan(100)
  expect(output.response.Histories.length).toBeLessThan(3000)
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(200 * 1024 + 1)
})
it.each([
  ['DeleteAlarmPolicy', '{"Module":"monitor"}'], ['ModifyAlarmPolicyStatus', '{}'], ['GetMonitorData', monitorData(25 * 3600)],
  ['GetMonitorData', monitorData().replace('"Period":60', '"Period":10')], ['GetMonitorData', '{"Period":60}'],
  ['DescribeAlarmHistories', JSON.stringify({ Module: 'monitor', PageSize: 500, StartTime: 1, EndTime: 3600 })],
  ['DescribeAlarmHistories', JSON.stringify({ Module: 'monitor', StartTime: 1, EndTime: 8 * 86400 })],
  ['DescribeAlarmHistories', '{"Module":"monitor"}'], ['DescribeBaseMetrics', '["x"]'], ['DescribeBaseMetrics', 'not json'],
  ['DescribeBaseMetrics', JSON.stringify({ Namespace: 'x'.repeat(9000) })],
])('refuses monitor %s %s without a request', async (action, params) => {
  monitorConfig(await serve({ Response: { RequestId: 'm3' } }))
  const result = await run(['monitor', '--env', 'prod', '--action', action, '--params', params])
  expect(result).toMatchObject({ code: 2, stderr: expect.stringMatching(/^refused:/) })
  expect(requests).toHaveLength(0)
})
it('refuses a malformed monitor region without a request', async () => {
  monitorConfig(await serve({ Response: { RequestId: 'm4' } }))
  const result = await run(['monitor', '--env', 'prod', '--action', 'DescribeBaseMetrics', '--params', '{"Namespace":"QCE/CDB"}',
    '--region', 'evil.example.com'])
  expect(result).toMatchObject({ code: 2, stderr: expect.stringMatching(/^refused: region/) })
  expect(requests).toHaveLength(0)
})
it('reports a Cloud Monitor error without the secret', async () => {
  monitorConfig(await serve({ Response: { RequestId: 'm5', Error: { Code: 'AuthFailure.UnauthorizedOperation',
    Message: `denied for ${SECRET_ID} ${SECRET_KEY}` } } }))
  const result = await run(['monitor', '--env', 'prod', '--action', 'DescribeBaseMetrics', '--params', '{"Namespace":"QCE/CDB"}'])
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout)).toEqual({ error: { code: 'AuthFailure.UnauthorizedOperation', message: 'denied for *** ***' },
    requestId: 'm5' })
  expect(requests[0]!.headers['x-tc-region']).toBe('na-ashburn')
  expect(result.stdout + result.stderr).not.toContain(SECRET_KEY)
})

const matrix = { status: 'success', data: { resultType: 'matrix', result: [{ metric: { provider: 'a' }, values: [[1762800000, '1']] }] } }
it('runs a range query through PROM_URL with Basic auth and a raised step', async () => {
  const url = await serve(matrix)
  config('prod', [`PROM_URL=${url}/prom/`, 'PROM_USER=1250000000', `PROM_TOKEN=${PROM_TOKEN}`])
  const result = await run(['prom', '--env', 'prod', 'range', '--query', 'sum(rate(x[5m])) by (provider)', '--from', '1762700000000',
    '--to', '1762786400000', '--step', '15'])
  expect(result.code).toBe(0)
  const parsed = new URL(requests[0]!.url!, 'http://h')
  expect(requests[0]!.method).toBe('GET')
  expect(parsed.pathname).toBe('/prom/api/v1/query_range')
  expect(Object.fromEntries(parsed.searchParams)).toEqual({ query: 'sum(rate(x[5m])) by (provider)', start: '1762700000',
    end: '1762786400', step: '79' })
  expect(requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`1250000000:${PROM_TOKEN}`).toString('base64')}`)
  expect(JSON.parse(result.stdout)).toEqual({ status: 'success', step: 79, resultType: 'matrix', result: matrix.data.result })
  expect(result.stdout + result.stderr).not.toContain(PROM_TOKEN)
})
it('queries Prometheus through the Grafana datasource proxy with the bearer token', async () => {
  const url = await serve({ status: 'success', data: ['provider', 'model'] })
  config('prod', [`GRAFANA_BASE_URL=${url}`, `GRAFANA_TOKEN=${GRAFANA_TOKEN}`, 'GRAFANA_PROM_UID=prom_1'])
  const result = await run(['prom', '--env', 'prod', 'labels', '--from', '-30m'])
  expect(result.code).toBe(0)
  expect(requests[0]!.method).toBe('GET')
  expect(new URL(requests[0]!.url!, 'http://h').pathname).toBe('/api/datasources/proxy/uid/prom_1/api/v1/labels')
  expect(requests[0]!.headers.authorization).toBe(`Bearer ${GRAFANA_TOKEN}`)
  expect(JSON.parse(result.stdout)).toEqual({ status: 'success', result: ['provider', 'model'] })
  expect(await run(['prom', '--env', 'prod', 'label-values', '--label', 'provider'])).toMatchObject({ code: 0 })
  expect(new URL(requests[1]!.url!, 'http://h').pathname).toBe('/api/datasources/proxy/uid/prom_1/api/v1/label/provider/values')
  expect(result.stdout + result.stderr).not.toContain(GRAFANA_TOKEN)
})
it('cuts series, then points, of a large matrix to fit the output limit', async () => {
  const series = (n: number, points: number) => Array.from({ length: n }, (_, index) => ({ metric: { provider: `p${index}` },
    values: Array.from({ length: points }, (_, t) => [1762800000 + t * 60, '12345.678']) }))
  config('prod', [`PROM_URL=${await serve({ status: 'success', data: { resultType: 'matrix', result: series(50, 1440) } })}`,
    `PROM_TOKEN=${PROM_TOKEN}`])
  const output = JSON.parse((await run(['prom', '--env', 'prod', 'range', '--query', 'up', '--from', '-24h'])).stdout)
  expect(output.truncated).toBe(true)
  expect(output.result.length).toBeLessThan(50)
  expect(output.result[0].values).toHaveLength(1440)
})
it.each([
  ['range', '--query', 'up', '--from', '-2d'], ['series', '--match', 'up', '--from', '-7h'], ['series'], ['query'],
  ['query', '--query', 'x'.repeat(4001)], ['label-values', '--label', 'bad-name'], ['label-values', '--label', '../x'],
  ['rules', '--query', 'up'], ['delete'], ['range', '--query', 'up', '--from', 'now', '--to', '-1h'],
])('refuses prom %s before any request', async (...args: string[]) => {
  config('prod', [`PROM_URL=${await serve(matrix)}`, `PROM_TOKEN=${PROM_TOKEN}`])
  const result = await run(['prom', '--env', 'prod', ...args])
  expect(result).toMatchObject({ code: 2, stderr: expect.stringMatching(/^refused:/) })
  expect(requests).toHaveLength(0)
  expect(result.stdout + result.stderr).not.toContain(PROM_TOKEN)
})
it('reports a Prometheus error answer with exit 1, and refuses plain HTTP to a non-loopback PROM_URL', async () => {
  config('prod', [`PROM_URL=${await serve({ status: 'error', errorType: 'bad_data', error: 'parse error' }, 400)}`, `PROM_TOKEN=${PROM_TOKEN}`])
  const result = await run(['prom', '--env', 'prod', 'query', '--query', 'up{'])
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'error', errorType: 'bad_data', error: 'parse error' })
  config('prod', ['PROM_URL=http://prom.example.com', `PROM_TOKEN=${PROM_TOKEN}`])
  expect(await run(['prom', '--env', 'prod', 'alerts'])).toMatchObject({ code: 2, stderr: expect.stringContaining('PROM_URL may use http://') })
})
it('lists monitor and prom only for complete configurations', async () => {
  config('a', [`MONITOR_SECRET_ID=${SECRET_ID}`, `MONITOR_SECRET_KEY=${SECRET_KEY}`, 'MONITOR_REGION=na-ashburn',
    'PROM_URL=https://prom.example', `PROM_TOKEN=${PROM_TOKEN}`])
  config('b', ['GRAFANA_BASE_URL=https://grafana.example', `GRAFANA_TOKEN=${GRAFANA_TOKEN}`, 'GRAFANA_PROM_UID=prom_1'])
  config('c', [`MONITOR_SECRET_ID=${SECRET_ID}`, `MONITOR_SECRET_KEY=${SECRET_KEY}`, 'PROM_URL=https://prom.example',
    `CLS_SECRET_ID=${SECRET_ID}`, `CLS_SECRET_KEY=${SECRET_KEY}`, 'CLS_REGION=na-ashburn'])
  const result = await run(['envs'])
  expect(JSON.parse(result.stdout).envs).toEqual([{ name: 'a', tools: ['monitor', 'prom'] }, { name: 'b', tools: ['grafana', 'prom'] },
    { name: 'c', tools: ['cls'] }])
  for (const secret of [SECRET_ID, SECRET_KEY, GRAFANA_TOKEN, PROM_TOKEN]) expect(result.stdout + result.stderr).not.toContain(secret)
})
