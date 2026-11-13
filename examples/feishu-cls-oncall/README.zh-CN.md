# 飞书告警只读值班（dsh-superagent 配置包）

这个目录是一套配置：dsh-superagent 不接 GitHub，只接飞书。腾讯云可观测平台的告警（Prometheus 告警、云产品监控告警、CLS 日志告警）发到飞书群后，智能体只读地排查（Prometheus 指标、云监控、CLS 日志、Kubernetes、可选 Grafana），在这条告警的线程里回复一条中文分析。网站兜底页告警（`【… 兜底页告警】`，404、页面错误）也能识别，默认只记录、不排查。它不改任何系统：不重启、不回滚、不发布、不改配置、不提 PR。

目录内容：

| 文件 | 作用 |
| --- | --- |
| `profile.cordis.patch.yml` | DSH profile 补丁：面板端口、`stateDir`、关 GitHub、开飞书、Anthropic 兼容的模型路由 |
| `settings/*.json` | 四个设置块：`source-feishu`、`policy`（规则 `tencent-alert` 开启、`fallback-page` 关闭）、`eval`、`executor` |
| `prompts/*.md` | 团队提示词：沟通（回复格式）、工单范围（只读）、交付要求（无 PR） |
| `skills/oncall-alerts.md` | 团队技能 `oncall-alerts`（会话里叫 `dsh-superagent-oncall-alerts`）：按告警类型的排查手册。这里是通用示例，部署前换成你自己的告警组、指标和环境映射 |
| `overrides/*.md` | 覆盖内置的 `runtime/worker`、`runtime/work`、`runtime/admission`，把 PR 和改代码的句子换成只读排查 |
| `overrides/bases.json` | 三个覆盖写作时所依据的内置文本的 key（`base`）。升级 dsh-superagent 后如果内置文本变了，面板会提示“默认内容已更新”，这时对照新内置文本修改覆盖，再更新这个文件 |

`scripts/oncall-apply` 把设置和提示词通过管理 API 存进运行中的服务；`scripts/dsh-oncall` 是 worker 用的只读工具。内置 `prompts/` 和策略代码都没改，所以同一份代码的 GitHub 部署不受影响。

## 架构与数据流

1. 腾讯云可观测平台的告警通知渠道（以及网站兜底页）把告警发到飞书告警群，发送者是告警机器人。
2. 飞书**不会**把一个机器人的消息作为事件推给另一个机器人，所以告警不走实时事件，而是由飞书 Source 的**历史补收**拿到：它每分钟读一次所配群的历史（第一轮只记位置，不补以前的消息）。所以从告警发出到开始处理，大约有 1 分钟延迟。
3. 告警群设成“全部消息”，告警机器人在策略的 `bots` 名单里，它的消息成为**推断的候选**，交给主 Session 评估。不在名单里的机器人的消息直接过滤掉（原因 `not_human`）。
4. 飞书 Source 把告警卡片转成纯文本，识别告警类型、状态（已触发、持续触发、已恢复）、告警策略和告警对象。同一策略、同一对象（去掉“当前 6.41 req/s”这类读数；云监控按实例 id 和告警内容）的告警归到同一个**告警线程**：重复触发、持续触发和恢复都落在这个线程上。
5. 宿主先过滤，不调模型：**恢复通知**直接忽略（原因 `alert_recovered`）；同一告警线程上已有进行中的工单时，**重复告警**直接忽略（`alert_repeat`），并作为输入交给那个工单。
6. 其余告警交给主 Session 按 `tencent-alert` 规则评估：正在触发的告警才接受；6 小时内同一告警线程上已经接受过（或在 `observe` 模式下“会接受”过）的重复告警、测试消息和兜底页告警都忽略。候选里的 `thread_decisions` 列出这个告警线程最近的判断，`observe` 模式下靠它识别重复。`observe` 模式只记录判断，`auto` 模式才建工单。
7. 接受时静默（不发“收到”），建工单，启动 worker。
8. worker 用 `dsh-oncall` 只读排查，约 10 分钟，然后报告 ready。
9. 主 Session 把分析作为**一条**回复发到第一条告警消息的线程里：**结论**、**证据**、**影响**、**建议**、**未确认**。

## 处理哪些告警

| 告警 | 识别方式 | 默认处理 |
| --- | --- | --- |
| Prometheus 告警（`🟥腾讯云可观测平台告警`，`…的Prometheus告警已触发 / 持续触发`） | 告警策略 `<组>/<告警名>`，如 `example_alerts_p2/ProviderQPSSpike`；告警对象去掉读数 | 规则 `tencent-alert` 评估；技能里有 ProviderQPSSpike、ProviderStreamTTFTSpike、ModelStreamTTFTSpike 等的排查步骤 |
| 云产品监控告警（`…的云产品监控告警持续触发`） | 告警策略，如 `MySQL-master-ro`；对象是实例 id，加上告警内容 | 规则 `tencent-alert`；MySQL 用 `dsh-oncall monitor` 读指标 |
| CLS 告警（卡片里写日志服务，或 CLS 文本通知） | 告警策略和日志主题 | 规则 `tencent-alert` |
| 任一告警的恢复（`🟩…已恢复` / `恢复`，CLS `通知类型：恢复`） | 状态词 | 宿主直接忽略，不调模型 |
| 网站兜底页告警（`【… 兜底页告警】`，404 或页面错误） | 类型和页面（去掉查询参数） | **待你决定**：规则 `fallback-page` 默认关闭，`tencent-alert` 会忽略它们，所以只在 **评估** 页留下“忽略”记录。要排查就在面板里开启 `fallback-page`（或改 `settings/policy.json` 后重跑 `oncall-apply`） |

## 安全边界

- worker 和主 Session 都以运行服务的 OS 用户、`danger-full-access` 运行，能执行该用户能执行的任何程序、读该用户能读的任何文件。
- `executor.json` 的 `blockedCommands`（kubectl、curl、tccli 等）和 `dsh-oncall` 的只读白名单都只是**纵深防御**：worker 可以用绝对路径绕过命令垫片。真正的边界是**只读凭据**：CLS、云监控、Prometheus、Kubernetes、Grafana 的凭据本身只能读。
- 管理 API 在 `127.0.0.1` 上，没有鉴权；同机的任何进程（包括 worker）都能改设置。
- 飞书机器人能在它所在的每个群发消息；worker 拿得到机器人的 `lark-cli`。
- 模型网关 Key 和凭据文件对同一 OS 用户可读，worker 也能读到。
- 推荐：用一个**专用 OS 账号**运行服务，这个账号只放智能体的凭据（只读云凭据、只读 kubeconfig、机器人配置、有额度上限的模型网关 Key），不放个人凭据、数据库或镜像仓库管理员凭据。

## 前提与版本

- Node.js 22.19+、pnpm、git 2.32+、Python 3.8+、tmux
- `lark-cli`（测过 1.0.90）
- DeepSeek Harness `@deepseek-ai/dsh@0.2.1-rc.3`。不要用 0.2.2-rc.1：它依赖 cordis 4.1、需要 Node 24.9+，本仓库的 peer 依赖还没升级。
- `kubectl`（给 `dsh-oncall kube` 用，不必在 PATH 上被 worker 直接调用）

## 飞书自建应用与机器人

1. 打开飞书开发者后台，创建**企业自建应用**。
2. 在“应用能力”里添加**机器人**。
3. 在“权限管理”里开通：
   - 获取与发送单聊、群组消息 `im:message`
   - 以应用的身份发消息 `im:message:send_as_bot`
   - 获取群组中所有消息 `im:message.group_msg`（历史补收靠它读到告警机器人的消息）
   - 获取群信息 `im:chat:readonly`
4. 在“事件与回调”里选**长连接**，订阅 `im.message.receive_v1`（接收 @ 机器人的消息；告警本身走历史补收）。
5. 创建版本并发布。
6. 在告警群的设置里把机器人加进群。

## lark-cli：只允许机器人身份

和 [006 Deployment](../../docs/006-deployment.md) 的 “Feishu bot” 一节相同，用单独的配置目录：

```sh
LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
mkdir -p ~/.local/bin
cat > ~/.local/bin/lark-bot <<'EOF'
#!/bin/sh
export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
exec lark-cli "$@"
EOF
chmod +x ~/.local/bin/lark-bot
```

第一条命令从标准输入读 App Secret。删除这套配置时只删目录，不要运行 `lark-cli config remove`（会影响共用的密钥）。

## 找到告警机器人的 sender id

先让告警群里至少有一条告警，然后读群里最近 5 条消息：

```sh
lark-bot api GET /open-apis/im/v1/messages \
  --params '{"container_id_type":"chat","container_id":"<oc_告警群>","sort_type":"ByCreateTimeDesc","page_size":5}' \
  --as bot --format json
```

找到告警那条消息，记下：

- `sender.id`：告警机器人的 id。必须是 `cli_` 或 `ou_` 开头，`bots` 名单才能放它。腾讯云可观测平台和兜底页的告警由同一个应用发出时，名单里放一个就够。
- `msg_type`：腾讯云可观测平台的告警是 `interactive`（卡片），兜底页告警是 `text`。卡片会先转成纯文本（标题一行，每行元素拼起来，链接写成 `文字(地址)`），再交给智能体和告警识别。
- 群的 `chat_id`（`oc_` 开头）。

## 只读凭据

每个环境（例如 `prod-a`、`prod-b`）准备一组只读凭据：

- **CLS**：在访问管理（CAM）里建一个子用户，只授予 `QcloudCLSReadOnlyAccess`，为它建 SecretId/SecretKey。
- **云监控**：另建一个子用户，只授予 `QcloudMonitorReadOnlyAccess`，给 `dsh-oncall monitor` 用（`MONITOR_SECRET_ID`、`MONITOR_SECRET_KEY`）。`dsh-oncall` 不会拿 CLS 的 Key 去调云监控。
- **Prometheus**，二选一：
  - Grafana（如 `grafana-….grafana.tencent-cloud.com`）里建一个 **Viewer** 角色的 service account 和 token，再查 Prometheus 数据源的 UID（`GRAFANA_BASE_URL`、`GRAFANA_TOKEN`、`GRAFANA_PROM_UID`），`dsh-oncall prom` 走 Grafana 的数据源代理；
  - 或者腾讯云 Prometheus（TMP）实例的 HTTP API 地址、APPID 和实例 token（`PROM_URL`、`PROM_USER`、`PROM_TOKEN`，Basic 认证；不设 `PROM_USER` 时用 Bearer）。
  两条路都实现并用本地服务测过，哪条在你的环境能用还没在生产验证。
- **Kubernetes**：在要看的命名空间里建 ServiceAccount，绑定内置 ClusterRole `view`（不含 Secret），给它单独的 kubeconfig：

  ```sh
  kubectl create serviceaccount dsh-oncall -n <ns>
  kubectl create rolebinding dsh-oncall-view --clusterrole=view --serviceaccount=<ns>:dsh-oncall -n <ns>
  kubectl create token dsh-oncall -n <ns> --duration=720h   # 集群可能限制最长时长
  ```

  用这个 token 写一份只给它用的 kubeconfig，然后检查：`kubectl --kubeconfig <它> auth can-i delete pods -n <ns>` 应该是 `no`。
  **警告**：给智能体前务必用 `kubectl auth can-i` 核对；能删 Pod、exec、改 Deployment 或读 Secret 的凭据不能用。
- **Grafana**（可选，读看板）：同上面 Viewer 的 service account。
- 不要给数据库、缓存、镜像仓库管理员或任何写权限的凭据。

## `~/.config/dsh-oncall/<env>.env`

每个环境一个文件，文件名就是 `--env` 的名字（小写字母、数字、`-`）。只有属主能读，否则 `dsh-oncall` 拒绝使用：

```sh
mkdir -p ~/.config/dsh-oncall && chmod 700 ~/.config/dsh-oncall
cat > ~/.config/dsh-oncall/prod-a.env <<'EOF'
CLS_SECRET_ID=<只读子用户的 SecretId>
CLS_SECRET_KEY=<只读子用户的 SecretKey>
CLS_REGION=ap-singapore
CLS_TOPIC_ID=<默认日志主题 ID>
CLS_TOPICS=apiserver=<主题 ID>,gateway=<主题 ID>
CLS_ENDPOINT=https://cls.tencentcloudapi.com
MONITOR_SECRET_ID=<只读云监控子用户的 SecretId>
MONITOR_SECRET_KEY=<只读云监控子用户的 SecretKey>
MONITOR_REGION=ap-singapore
PROM_URL=https://<TMP 实例的 HTTP API 地址>
PROM_USER=<APPID>
PROM_TOKEN=<实例 token>
KUBECONFIG=/home/oncall/.kube/dsh-oncall-prod-a.yaml
KUBE_CONTEXT=<context 名>
KUBE_NAMESPACE=<命名空间>
GRAFANA_BASE_URL=https://grafana.example.com
GRAFANA_TOKEN=<Viewer token>
GRAFANA_PROM_UID=<Prometheus 数据源 UID>
EOF
chmod 600 ~/.config/dsh-oncall/prod-a.env
dsh-oncall envs
```

`dsh-oncall envs` 只列环境名和可用工具（`cls`、`monitor`、`prom`、`kube`、`grafana`），不输出任何值；`prom` 在 `PROM_URL`+`PROM_TOKEN` 或 `GRAFANA_BASE_URL`+`GRAFANA_TOKEN`+`GRAFANA_PROM_UID` 齐全时才列出。`CLS_ENDPOINT`、`MONITOR_ENDPOINT` 必须是带 `https://` 的地址（只写主机名会被拒绝）。`GRAFANA_BASE_URL`、`PROM_URL` 和它们一样，只有 `127.0.0.1`、`localhost` 能用 `http://`，其他地址必须用 `https://`。`kube` 拒绝会读写本地文件的参数，比如 `-o go-template-file=…`、`--template`、`--profile-output`、`--cache-dir`；模板请直接写在 `-o go-template=…` 或 `-o jsonpath=…` 里。DSH 会从 worker 的 shell 里去掉名字含 KEY、SECRET、TOKEN、PASSWORD 的环境变量，所以凭据只能放文件里。`monitor` 只允许 `GetMonitorData`（最多 24 小时、`Period` 至少 60 秒）、`DescribeAlarmHistories`（最多 7 天、每页最多 100 条）、`DescribeBaseMetrics`、`DescribeAlarmPolicies`；`prom range` 最多 24 小时，`series`、`labels`、`label-values` 最多 6 小时。`dsh-oncall` 也认 `DSH_ONCALL_CONFIG_DIR`，但 DSH 0.2.1-rc.3 不把它传给 worker 的 shell（本地验证时确认），所以服务账号的 `~/.config/dsh-oncall` 是 worker 唯一能用的位置。

## 模型网关（Anthropic 兼容）

主 Session（评估）和 worker 都走同一个 Anthropic 兼容的 Messages 网关，在 profile 补丁里配成 pi-ai 适配器的路由 `anthropic-gateway`（`api: anthropic-messages`）：

- `baseURL`：网关根地址，不带 `/v1`（Anthropic SDK 自己加 `/v1/messages`），末尾不要 `/`。
- `models`：两个模型 id，一个给主 Session（`<router model id>`），一个给 worker（`<worker model id>`），例如主 Session 用轻量模型、worker 用能力最强的模型。这只是例子，填你的网关实际提供的 id；同样的两个 id 要传给 `oncall-apply` 的 `--router-model`、`--worker-model`。
- 不要把路由改名为 `anthropic`：pi-ai 会套用它内置的 Anthropic 默认值。
- Key 以 `x-api-key` 头发送。
- 给这个服务单独建一个**有额度上限的 Key**，不要用个人或组织的主 Key。

补丁里写的是 `apiKeyEnv: ONCALL_LLM_API_KEY`，它是凭据**名字**，不是值。DSH 0.2.1-rc.3 每次请求按这个顺序找值，先找到的生效：

1. `$DSH_HOME/.credentials.yaml` 里的 `refs.ONCALL_LLM_API_KEY`（推荐）
2. 启动 dsh 进程时的环境变量（启动时的快照，之后 export 的看不到）
3. 启动目录下的 `.env`
4. `$DSH_HOME/.env`

推荐写进凭据文件（DSH 会热加载，改了不用重启）：

```sh
umask 077
cat > "$DSH_HOME/.credentials.yaml" <<'EOF'
version: 1
refs:
  ONCALL_LLM_API_KEY: <你的 Key>
EOF
chmod 600 "$DSH_HOME/.credentials.yaml"
```

如果文件已经存在，只在 `refs` 下加一行，别覆盖别的条目。为什么不推荐用环境变量：`scripts/dsh-superagent start` 在 tmux 里启动 dsh。tmux 服务器已经在跑时，新窗口拿到的是 **tmux 服务器的环境**，不是你当前 shell 的环境，所以 `export ONCALL_LLM_API_KEY=… && scripts/dsh-superagent start` 可能不生效。`~/.local/bin` 是否在 PATH 上也取决于 tmux 服务器的环境。

## 安装与 profile

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <本仓库> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null   # 只在第一次、还没有 superagent profile 时运行
dsh plugin --profile superagent add "link:$PWD"
cp examples/feishu-cls-oncall/profile.cordis.patch.yml ~/.dsh/profiles/superagent/cordis.patch.yml
ln -sf "$PWD/scripts/dsh-oncall" ~/.local/bin/dsh-oncall
```

然后编辑 `~/.dsh/profiles/superagent/cordis.patch.yml`，把 `stateDir` 换成绝对路径，把 `<Anthropic-compatible base URL>`、`<router model id>`、`<worker model id>` 换成网关地址和两个模型 id。`--from-default-profile` 会重建 profile、删掉它的 `cordis.patch.yml`，升级时不要再运行。用别的目录时设置 `DSH_HOME`，上面的 `~/.dsh` 都换成它。

模型：补丁把 Anthropic 兼容网关配成 provider `anthropic-gateway`，声明主 Session 和 worker 两个模型；新 Session 默认用主 Session 的模型。设置块 `eval.json`、`executor.json` 里的模型 id 是占位符，由 `oncall-apply` 填入。

## 应用设置

先启动服务（见下一节），它会停在“等待设置”，然后：

```sh
scripts/oncall-apply --lark-cli "$HOME/.local/bin/lark-bot" --alert-chat <oc_告警群> --alert-bot <cli_告警机器人> \
  --router-model <主 Session 模型 id> --worker-model <worker 模型 id>
```

- 多个群或多个告警机器人用逗号分隔：`--alert-chat oc_a,oc_b`。
- 默认 `observe`：只记录判断，不建工单，也不在群里发消息。先在面板的 **评估** 页看几天它对真实告警的判断（触发的“会接受”、恢复是 `alert_recovered`、6 小时内的重复被忽略），确认无误、只读凭据也就绪后，再用 `--mode auto` 重跑一次。
- `--router-model`、`--worker-model` 必填（kit 里的模型是占位符，不填脚本拒绝并指出缺哪个）：填 profile 路由 `anthropic-gateway` 里声明的 id，provider 固定是 `anthropic-gateway`。
- `--dry-run` 只打印要发的请求，不发。
- `--url` 改面板地址（默认 `http://127.0.0.1:3082`）。
- 顺序是 `source:feishu` → `policy` → `eval` → `executor` → 提示词。机器人 CLI 变了，或服务还在等待设置时，保存会重启 dsh-superagent（回答里 `restarting: true`），脚本会等它重新应答（最多 120 秒）再继续。被拒绝时脚本以非零退出，并打印服务端的 `error` 和 `setup` 信息。

想让值班同学在线程里 @ 机器人追问，可以在面板设置 **策略** 的飞书名单里加他们的 open_id；他们的请求同样受只读提示词约束。注意重跑 `oncall-apply` 会用 `settings/policy.json` 覆盖整个策略块，名单会被清空：要保留就先把他们写进那个文件的 `allowed`。

## 启停与状态

```sh
scripts/dsh-superagent start     # 在 tmux 会话 dsh-superagent 里启动
scripts/dsh-superagent status
scripts/dsh-superagent restart
scripts/dsh-superagent stop      # 等 worker 结束，最多 5 分钟；不强杀
```

`status`、`start`、`restart` 的退出码：

| 退出码 | 含义 |
| --- | --- |
| 0 | 正常运行 |
| 1 | 没运行、运行了两个、不应答或运行时报错；重启可能修好 |
| 2 | 在运行，但某个部分（比如飞书 Source）报错；重启修不好，看 `errors` |
| 3 | 在运行，等待设置；重启修不好，看 `setup` |

日志在仓库的 `.artifacts/dsh-superagent-superagent-*.log`。面板地址在日志里，打开后选侧栏的 **Superagent**。

## 每小时健康检查

在你平时用的**另一个** DSH profile 里（服务挂了它也要能跑），让智能体按这个提示词建一个每小时的定时任务，填上仓库路径：

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

不用智能体也可以：用 launchd 或 cron 每小时跑一次，只在 `status` 退出 1 时重启：

```sh
cd <checkout> && { scripts/dsh-superagent --profile superagent status >/dev/null; [ $? -eq 1 ] && scripts/dsh-superagent --profile superagent --respect-stop restart; }
```

`--respect-stop` 保留人为的 `stop`。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 告警发了，面板上什么都没有 | 历史补收每分钟一轮，第一轮只记位置；等 1–2 分钟。确认群设成“全部消息”、机器人有 `im:message.group_msg` 权限、在群里 |
| 面板 **评估** 页的判断原因是 `not_human` | 告警机器人的 sender id 不在 `bots` 名单里，或 id 不对；按上面的方法重新读 |
| 判断原因是 `alert_recovered` 或 `alert_repeat` | 正常：恢复通知，或同一告警线程上已有进行中的工单 |
| 兜底页告警都被忽略 | 正常：规则 `fallback-page` 默认关闭 |
| 判断是“会接受”但没建工单 | 还在 `observe` 模式；确认后用 `--mode auto` 重跑 `oncall-apply` |
| `modelUnavailable` | 模型路由没加载、模型 id 不在路由里或 Key 缺失：检查 profile 补丁（`anthropic-gateway` 和两个模型 id）和 `.credentials.yaml`，重启服务 |
| 请求失败 `MISSING_CREDENTIAL` | DSH 找不到 `ONCALL_LLM_API_KEY`；写进 `$DSH_HOME/.credentials.yaml` |
| worker 报 `refused: … .env` | 凭据文件不存在、权限不是 600，或缺某个键 |
| worker 报 `kubectl was not found on PATH` | 在 env 文件里设 `KUBECTL=/绝对路径/kubectl` |
| `status` 退出 3 | 看 `setup`，通常是还没运行 `oncall-apply` 或机器人 CLI 不对 |
| 其他 | 见 [006 Deployment](../../docs/006-deployment.md) 的 Troubleshooting |

## 未验证事项

- 真实飞书投递、权限和告警群里的实际效果。
- 腾讯云卡片和兜底页告警的测试数据取自真实告警群的消息（已脱敏）；CLS 文本告警仍是按 [CLS 告警通知变量](https://cloud.tencent.com/document/product/614/74718) 合成的，真实群里还没见过 CLS 告警。
- `dsh-oncall prom` 在生产上走 TMP 还是 Grafana 代理：还没有只读凭据，没验证。
- 历史补收的实际延迟。
- 生产凭据，以及 `anthropic-messages` 路由在长时间真实请求下的表现（上下文长度、思考内容；DSH 对这个路由不计费用，面板显示的花费为 0）。
- 保存飞书设置后重启的时长；脚本最多等 120 秒。
- 长时间无人值守运行。
