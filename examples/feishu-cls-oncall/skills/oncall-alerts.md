Runbook for a read-only investigation of a Tencent Cloud alert posted to Feishu: parse the alert, find the environment, follow the playbook for its type, report evidence.

This is the generic example shipped with dsh-superagent. Replace the environment mapping in section 2 and the playbook in section 3 with your own alert groups, metrics and environments before you deploy it.

## 1. Parse the alert

Before investigating, run `dsh-oncall known`: it lists the known open issues the daily ticket digest keeps. When the alarm matches one, confirm with one or two queries that the cause is unchanged and what is new, answer with 已知问题：<title> and its first-seen time in **结论**, and stop there; investigate in full only when the evidence shows a different cause.

The alert chat receives these formats; the trigger text is the message rendered as plain text.

- **Tencent Cloud Observability card** (title `🟥腾讯云可观测平台告警` firing, `🟩腾讯云可观测平台告警` recovered). The second line names the kind (`…的Prometheus告警`, `…的云产品监控告警`, CLS for 日志服务) and the status: `已触发` (firing), `持续触发` (still firing, a periodic repeat), `已恢复` / `恢复` (recovered).
  - Prometheus fields: `告警内容` (the rule's description), `告警对象` (the rule's summary with the current value, such as `供应商 provider-a 流量突增（当前 6.41 req/s）`), `告警策略` (`<group>/<alert name>`, such as `example_alerts_p2/ProviderQPSSpike`), `时间：触发时间: … (UTC+08:00)` with `恢复时间` or `持续时间`, and a Grafana dashboard link whose variables name the labels.
  - Cloud Monitor fields: `告警内容` (`<product> | <metric> <condition>`), `告警对象` (instance id first, then 实例名 and the IP), `当前数据`, `项目|地域`, `告警策略`, `触发时间`, `持续时长`, `恢复时间`.
- **CLS text notice**: `告警策略`, `通知类型` (告警 or 恢复), `日志主题`, `地域`, `触发条件`, `开始时间`, `持续时间`, `详情链接`.
- **Site fallback page** (`【兜底页告警】`): `类型` (404 页面不存在 or 页面错误), `页面`, `来源`, `错误`, `UA`, `IP`, `时间`.

The host ignores recoveries before you see them; if your alert has recovered meanwhile, still report what happened while it fired. Times are Asia/Shanghai (UTC+08:00) unless the alert says otherwise; pass them to `--from` and `--to` as ISO-8601 with `+08:00`, or as epoch milliseconds.

## 2. Find the environment

Run `dsh-oncall envs`. It lists each environment's name, its tools (`cls`, `prom`, `monitor`, `kube`, `grafana`) and the facts that route an alert to it: the operator's `description`, `clsRegion`, `clsTopics` (topic names), `monitorRegion` and `kubeNamespace`; never credentials, topic ids or endpoints. Match the alert's region, topic or Prometheus group against those facts. Example mapping; replace it with yours, or write it into each environment's `DESCRIPTION`:

- Cloud Monitor `项目|地域`: the region names the environment, for example 新加坡 → `prod-a` (`ap-singapore`).
- Prometheus groups: a naming convention per environment, for example `example_alerts_*` → `prod-a`, `example_region_b_alerts/*` → `prod-b`.
- CLS: the region and topic of the notice.

When `envs` lists no matching environment, or not the tool a step needs, that environment or tool is not configured for you: skip that step and say so in **未确认**; never guess its result. Do not search the filesystem or the environment for credential files, kubeconfigs or keys, and do not set `DSH_ONCALL_CONFIG_DIR` yourself.

## 3. Playbook by alert

Rerun the rule's expression over the alert window with `dsh-oncall prom --env <env> range --query '<PromQL>' --from <trigger time - 30m> --to <now or recovery> --step 60`, then the neighbouring signals, then confirm in logs. The table shows the kind of entry to write for each of your alert rules; the metric names are examples.

| Alert | Rule (fires when) | Then check |
| --- | --- | --- |
| ProviderQPSSpike | `sum by(provider) (rate(app_provider_request_total[3m])) > … offset 15m * 3`, for 3m | Which other provider's QPS fell, or its failure rate or latency rose, in the same 15 minutes. A matching drop is a fallback shift; the cause is the failing provider. No drop: a traffic surge, check traffic by model or by customer |
| ProviderLatencySpike | `histogram_quantile(0.95, sum by(le, provider) (rate(app_provider_latency_seconds_bucket[10m]))) > 45`, for 5m | The same quantile by `le, provider, model` to find the slow model; the provider's failure rate and 429s; whether other providers of that model are fast |
| ProviderHighFailureRate | failed / all requests of a provider over 5m > 30 %, for 5m | Errors by `error_code, model` (401/403 credentials, 429 limits, 5xx upstream); CLS errors of that provider |
| PodCrashLooping, ContainerOOMKilled | `kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}` / `…last_terminated_reason{reason="OOMKilled"}` | Section 5: describe the pod, previous logs, events, rollout history; memory working set vs limit (`container_memory_working_set_bytes`) |
| HighMemoryUsage | `process_resident_memory_bytes > 2e9`, for 5m | RSS trend over 6 h (leak vs spike), pod restarts, traffic at the same time |

For any other Prometheus alert, read its expression with `dsh-oncall prom --env <env> rules`, rerun it, and check the same neighbouring signals.

**Cloud Monitor MySQL** (`云数据库-MySQL-…`, object `cdb-…`): read the instance's metrics over the last 6 h, one call per metric, with `dsh-oncall monitor --env <env> --action GetMonitorData --params '{"Namespace":"QCE/CDB","MetricName":"MemoryUseRate","Period":300,"StartTime":"<ISO>","EndTime":"<ISO>","Instances":[{"Dimensions":[{"Name":"InstanceId","Value":"<cdb-id>"}]}]}'` for `MemoryUseRate`, `CpuUseRate`, `ThreadsConnected`, `Qps` and `SlowQueries`, and the alarm's history with `--action DescribeAlarmHistories --params '{"Module":"monitor","PageNumber":1,"PageSize":20,"StartTime":<epoch s>,"EndTime":<epoch s>}'`. A memory rate that climbs for hours with flat connections and QPS is buffer-pool growth, not an incident; a jump with connections or slow queries points to load.

**Site fallback page**: from `页面`, whether the path is a published page (CLS access logs of the front end for the same path and its referrer, repeated hits, crawler user agents); for 页面错误, the error text and the front-end release at that time. Say what the page is: a path such as `/apis/<provider>/<api>` names an API's documentation page, so check whether the platform serves that API (its name in CLS request logs or as a Prometheus `model` label) — a served API without its page is a missing documentation page. Count how often the same page failed in the last 24 h by reading the alert chat's history with read-only lark-cli calls, and judge the visitor from `来源`, `UA` and the spread of `IP` (a direct visit from many addresses with one browser version is often a crawler). Without front-end logs in any environment, say so under **未确认**.

### CLS queries

Search the alert's own topic (`--topic <TopicId>`) around the alert: from the start minus the duration (at least 15 minutes) to the start plus the duration (or now). Start small (`--limit 20`) and narrow before widening.

```sh
dsh-oncall cls --env <env> --topic <TopicId> --from <start> --to <end> --query '<the alert condition query>'
dsh-oncall cls --env <env> --topic <TopicId> --from <start> --to <end> --limit 20 --query 'status:>=500'
dsh-oncall cls --env <env> --topic <TopicId> --from <start> --to <end> --query 'status:>=500 | select path, count(*) as c group by path order by c desc limit 10'
dsh-oncall cls --env <env> --topic <TopicId> --from <start> --to <end> --query 'level:ERROR | select message, count(*) as c group by message order by c desc limit 10'
dsh-oncall cls --env <env> --topic <TopicId> --from <earlier window> --to <start> --query '<same analysis>'
```

Rerun the alert's own condition first to confirm the numbers, then the error counts by path or message, then the top error messages, then the same analysis for an earlier window as the normal baseline. Field names depend on the topic's index; read a few raw results first when a field query returns nothing. When a topic indexes a field with statistics, count with SQL instead of sampling: `--query '<filter> | select provider, count(*) as n group by provider order by n desc limit 20'` returns exact counts in `analysis`; a field that is not indexed comes back as `null` or an error, and then sampling is the fallback. When CLS answers that a field is not indexed, query `*` or a full-text word with a `--limit`, count the fields of the results yourself, and say in the reply that the counts are a sample.

## 4. Prometheus and Grafana reads

`dsh-oncall prom` reads the Prometheus HTTP API: `query --query Q [--time T]`, `range --query Q --from --to --step` (at most 7 days; the step is raised to keep about 1100 points, so a 7-day window has steps of 550 s or more), `series --match M`, `labels`, `label-values --label NAME` (windows at most 6 h), `rules`, `alerts`. When the environment lists `grafana`, `dsh-oncall grafana --env <env> /api/search --param query=<name>` finds a dashboard such as the one the alert links.

`dsh-oncall cdb --env <env> --action DescribeSlowLogData --params '{"InstanceId":"<id>","StartTime":<epoch s>,"EndTime":<epoch s>,"Limit":100,"SortBy":"Timestamp","OrderBy":"DESC"}'` reads a TencentDB for MySQL slow log (at most 24 h, literals masked as `?`) with a `Summary` ranking the statements by total query time; `--action DescribeDBInstances` lists the instance ids. For a database alarm such as IOPS or CPU at its limit, read the slow log of that instance before guessing at the cause.

`dsh-oncall db --env <env> --query '<one SELECT ... LIMIT n>'` runs one reading statement (SELECT or WITH ending in `LIMIT n`, n at most 200, or SHOW, EXPLAIN, DESCRIBE) on the environment's MySQL read-only instance, in a read-only session of at most 10 s; credential and contact columns come back as `<hidden>`. The read-only instance also serves reports, so filter on indexed columns (`SHOW INDEX FROM <table>`), keep time ranges short, and prefer one aggregate over many row reads.

## 5. Read Kubernetes

Find the workload from the alert labels or log fields (service, pod, container) and read its state:

```sh
dsh-oncall kube --env <env> get deploy,rs,pods -o wide
dsh-oncall kube --env <env> describe pod <pod>
dsh-oncall kube --env <env> get events --sort-by=.lastTimestamp
dsh-oncall kube --env <env> logs <pod> --since=30m --tail=200
dsh-oncall kube --env <env> logs <pod> --previous --tail=200
dsh-oncall kube --env <env> rollout history deploy/<name>
dsh-oncall kube --env <env> top pods
```

Look for restarts and their reasons (OOMKilled, CrashLoopBackOff, failed probes), a rollout or a new ReplicaSet near the start, pending pods, node pressure and image or configuration errors in events. Secrets and ConfigMap contents are not readable; do not try.

## 6. Conclude and report

Keep the investigation proportionate: most alarms are settled within about 40 dsh-oncall calls. Ask one question per query: group by a label (`sum by (provider, status) (...)`) instead of one query per provider, and read a baseline with one 7-day `range` at a coarse step instead of several 24 h windows. Stop once two independent signals agree on a cause, such as a metric and the matching log lines, and write the conclusion. When about 15 queries in a row add nothing, stop too: conclude with what was found, 低 confidence and the open question in **未确认**, rather than querying on.

Tie each conclusion to evidence: a QPS drop of provider A at 22:04 followed by the spike on provider B at 22:06 is evidence of a fallback shift; a deploy on the same day is not. Prefer one well-supported cause with 中 confidence over several guesses. Report ready with the reply in the Communication section's format (**结论**, **证据**, **影响**, **建议**, **未确认**) first, then the full evidence: each command or query exactly as run, its time range and its key numbers. Mask IPs as the Communication section says, and quote no hostnames, account ids or secrets beyond what the alert itself shows.

## 7. Propose a fix

Submit a fix only when all of these hold: two independent signals confirm the cause with 高 or 中 confidence; a small code or configuration change in one repository fixes it, such as a missing redirect or route, a wrong config value or copy, or a small bug; and it needs no product or design decision. Do not submit for a provider outage, a quota, billing, capacity, a data fix, an alert rule (those are changed in the cloud console), or anything that needs a rollback or deploy decision.

Before submitting, run `oncall-fix status`: when a fix for the same problem is listed and has not ended as `failed` or `no_pr`, do not submit again; name that fix's pull request in your reply instead.

Write the brief to a file in the ticket directory, in English, with four parts: **Problem** (what is wrong and since when), **Evidence** (Beijing times, counts, example requests or URLs, with IPs masked), **Change wanted** (what should change, not how), and **Out of scope**. Quote no secrets, hostnames or account ids beyond what the alert shows. Then run `oncall-fix submit --repository <owner/name> --brief <file>`. It starts a separate agent that opens a pull request, has it reviewed, and replies the pull request into this alert's topic; do not wait for it. In the reply's **建议**, say `已发起自动修复，PR 会回复在本话题。`

List the repositories a fix may target, with what each serves, in your copy of this skill.
