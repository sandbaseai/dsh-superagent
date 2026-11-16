# This fork

This repository is a fork of [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
(remote `upstream`, push disabled), which is a research prototype with one commit, `8c32a9d`. Upstream does not take
outside pull requests to its core, so this fork maintains its own changes. This file lists them so that a sync with a
later upstream knows what to keep, and so that generic fixes can be offered upstream.

## Generic changes

They do not depend on the on-call kit and would suit upstream as they are.

| Change | Where | Pull requests |
| --- | --- | --- |
| GitHub is optional: with no repository or CLI on the GitHub Source, setup resolves a Feishu-only deployment | `src/deployment.ts`, `src/infra/commands.ts`, `src/infra/environment.ts`, `src/app/runtime.ts`, `src/app/prompts.ts` | #1 |
| Feishu cards and rich text render as plain text instead of JSON | `src/sources/feishu-trigger.ts` | #1 |
| `trustedHosts`: the management API also accepts a reverse proxy's Host | `src/app/http.ts`, `src/deployment.ts` | #1 |
| Feishu history recovery rereads the last ten minutes each round, so a message the history API lists late is not lost | `src/sources/feishu-loops.ts` | #4 |
| A candidate carries the Thread's recent Decisions, and the nearby Tickets of the same Source (`eval.nearbyMinutes`) | `src/core/evals.ts`, `src/core/ports.ts`, `src/app/assessment.ts` | #1, #7, #13 |
| A reply may attach files from its Ticket's directory (`SourceChannel.send` gets the directory) | `src/sources/kind.ts`, `src/sources/registry.ts`, `src/app/outbox.ts` | #19 |
| `SourceKind.screen`: a Source sets its bots' messages aside before assessment with its own reason code | `src/sources/kind.ts`, `src/sources/registry.ts`, `src/core/ports.ts`, `src/policy.ts` | #21 |
| CI, ruff for the Python scripts | `.github/workflows/ci.yml`, `pyproject.toml` | #22 |
| The deploy script, and the hourly health check | `scripts/dsh-superagent-deploy`, `scripts/oncall-health` | #2, #3, #6, #23, #26 |

## On-call changes

They serve the Feishu alert on-call deployment and should stay in this fork, or move into a separate plugin.

| Change | Where |
| --- | --- |
| Alert parsing, alert Threads, the `alerts` health entry, and `screenAlert` | `src/sources/feishu-alert.ts` |
| Repeat notices | `src/sources/feishu-repeat.ts` |
| Chart replies (`[[chart:…]]` lines) | `src/sources/feishu-channel.ts` |
| The kit, the read-only tools and the digests | `examples/feishu-cls-oncall/`, `scripts/dsh-oncall`, `scripts/oncall-*` |

The deployment's real configuration (chat ids, environments, runbooks) is not in this repository.

## Syncing with upstream

1. `git fetch upstream` and read `git log 8c32a9d..upstream/main`.
2. Merge `upstream/main` on a branch, not `main`, and resolve conflicts with the tables above: keep the generic and
   on-call changes unless upstream made the same change.
3. Run `pnpm check` and `pnpm lint:scripts`, open a pull request, and deploy it like any other change.

## Security notes

- The management API has no authentication of its own. It answers loopback requests and, with `trustedHosts`, requests
  forwarded by a reverse proxy, which must then authenticate every request (the deployment uses Basic Auth). Anyone who
  reaches it can change the Policy and the prompts.
- Workers run as the service's OS user with full access; command shims are defense in depth. The boundary is the
  read-only credentials in `~/.config/dsh-oncall`, and `dsh-oncall db` refuses an account that may do more than read.
