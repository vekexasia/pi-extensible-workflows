# Built-in subagent extension

Single-shot agents for Pi: each run launches one independent agent session from one task, without writing a workflow script. Single-shot describes the orchestration shape, not one model turn; the agent can use tools and accept steering while it runs.

[Full Subagents documentation](https://vekexasia.github.io/pi-extensible-workflows/subagents.html) | [Main package](https://github.com/vekexasia/pi-extensible-workflows#readme) | [Roles](https://vekexasia.github.io/pi-extensible-workflows/roles.html) | [Settings](https://vekexasia.github.io/pi-extensible-workflows/developers.html#settings)

Use the built-in subagent tools for focused, independent tasks. Use `pi-extensible-workflows` when work needs dependency batches, parallel or pipeline stages, checkpoints, approvals, or resumable orchestration.

## Subagents vs workflows

| Built-in subagent tools | `pi-extensible-workflows` |
| --- | --- |
| One independently launched agent per run | A deterministic script orchestrating one or more agents |
| One task with a durable ID and lifecycle controls | Multi-stage coordination, dependencies, approvals, replay, and resume |
| Start in the background or wait in the foreground | Run a named workflow in the background or foreground |

## Highlights

- Five focused tools: run, inspect, steer, stop, and retry.
- Background fan-out with one durable ID per run, or foreground execution with an inline terminal result.
- Reuses workflow roles, model aliases, settings, and agent options: `label`, `model`, `tools`, `skills`, `extensions`, `contextFiles`, `worktree`, `outputSchema`, `retries` (0 through 255), and `timeoutMs`.
- Repeatable inspection of progress, token accounting, tool calls, results, failures, and worktrees.

Built-in subagent tools are available when the core extension is installed. Use the core package's Pi extension manifest to enable them.

## Quick start

Start work in the background and inspect it later:

```text
subagents_run({ prompt: "Review the current changes.", label: "review" })
# => { "id": "...", "state": "running" }

subagents_inspect({ id: "..." })
# => progress while running, then the terminal value or error
```

Use foreground mode when the result must return in the same tool call:

```text
subagents_run({ prompt: "Summarize README.md.", mode: "foreground" })
# => { "id": "...", "state": "completed", "value": ... }
```

## Interactive inspection

In Pi's TUI, `/subagents` opens a picker of durable standalone runs for the current session. Select a run to inspect the same activity, stall warning, state, model, role, tools, attempts, duration, cumulative token accounting, cost, and error fields used by `/workflow`; prompt, request failure, and result details remain bounded, and requests without a role remain `role=none`. The detail view also exposes registered standalone agent actions plus `Steer` and `Stop` while running, `Retry` for failed or stopped runs, and copy/editor controls where applicable. Inspection does not launch a new LLM call; lifecycle actions may steer, stop, or retry a run.

## Tools

Every tool schema is a closed object. Unknown properties are rejected. The model-visible standalone surface contains exactly these five names:

| Tool | Input schema |
| --- | --- |
| `subagents_run` | `{ prompt: string, mode?: "background" \| "foreground", label?: string, model?: string, tools?: string[], skills?: string[], extensions?: string[], contextFiles?: string[], role?: string, worktree?: string, outputSchema?: object, retries?: integer 0..255, timeoutMs?: positive integer \| null }` |
| `subagents_inspect` | `{ id?: string }` |
| `subagents_steer` | `{ id: string, message: string }` |
| `subagents_stop` | `{ id: string }` |
| `subagents_retry` | `{ id: string }` |

`prompt` is the only required `subagents_run` property. `mode` defaults to "background". Resource candidates start enabled, so plain positive top-level selector lists are additive and top-level `[]` adds no matches. Use `["!*", "read", "grep"]` to restrict a selector to those resources, or `["!*"]` to select none. A `role` string selects an existing workflow role. Model, tools, skills, extensions, and contextFiles are top-level `AgentOptions` overrides applied after the role file. Concrete models are `provider/model:thinking`. Capability selectors use ordered minimatch rules and are applied after global, trusted-project, and role selectors. Use `tools: ["*"]` to re-enable all tools after a role restriction.

`subagents_inspect({})` returns all accessible run summaries ordered by start time. `subagents_inspect({ id })` returns the detailed lifecycle record, including state, start and finish timestamps, and the live snapshot under `progress`: `state`, cumulative `accounting`, `toolCalls`, `activity`, and `lastEventAt`. The snapshot state never includes the effective system prompt, and inspection has no `usage` field; token totals are derived from accounting. Materialized worktree path and branch are included when available. For completed runs it also includes `value`; for failed runs it includes `error`. A running run has no terminal value yet. Unknown IDs fail with `RUN_NOT_FOUND`.

## Launching and concurrency

Background mode starts execution immediately and returns one durable UUID:

```json
{"id":"01900000-0000-4000-8000-000000000000","state":"running"}
```

Use foreground mode when the terminal envelope is needed in the same tool call:

```json
{"id":"01900000-0000-4000-8000-000000000000","state":"completed","value":{"answer":"done"}}
```

A foreground failure returns `{"id":"...","state":"failed","error":{"code":"AGENT_FAILED","message":"..."}}`. Foreground cancellation aborts the active native session and persists a failed record with code `CANCELLED`. A foreground run does not generate a background completion follow-up.

Each call owns an independent run, so calls can execute concurrently and settle independently up to the effective workflow `concurrency` setting for the launch context (an integer from 1 through 16, default 8). When the limit is reached, `subagents_run` and `subagents_retry` reject with `AGENT_FAILED`; no queue is maintained, so retry after an active run settles. Background completed and failed runs can produce one follow-up message when the host supplies `sendMessage`; the message points to the ID and `subagents_inspect` rather than embedding the full result.

## IDs, inspection, and terminal values

Run records are stored below the agent directory's private `subagents/` directory, normally `~/.pi/agent/subagents/<id>/`. The record includes the normalized request, including its launch mode, and status. A shared storage owner marker uses the process ID, process start, session ID, and token; every running record carries the same manager identity so a live manager does not reconcile another manager's active run.

Inspection is repeatable. Use the list form for ordered summaries and the ID form for one detailed status plus its terminal value or failure information. Progress is retained in memory and is persisted when the executor marks a progress update for persistence. The result and failure files remain available after manager restart.

## Steering and stopping

`subagents_steer` sends a message to a running agent. Messages sent before the executor exposes its steering handler are queued and delivered in order. The queue is bounded at 16 pending messages. Steering a settled, stopped, or unknown run fails; steering never targets a sibling run.

`subagents_stop` aborts only the selected run, clears its steering queue, persists `state: "stopped"`, aborts its active session, and cleans its worktree. Stopping one run does not stop other runs. Use this tool when the desired terminal state is `stopped`; cancelling a foreground `subagents_run` instead records `failed` with `CANCELLED`.

## Retries

`subagents_retry` is available for `failed` and `stopped` runs. It reads the original normalized request and starts a fresh execution with a new UUID. The old record and ID remain available. Completed or currently running runs are not retryable. The retry preserves the original `background` or `foreground` launch mode, so retrying a foreground run returns its new terminal envelope inline.

## Worktrees

Set `worktree` on `subagents_run` to create a named isolated Git worktree for that run. The default adapter uses the core `RunStore`: the worktree branches from the repository's clean `HEAD`, and a dirty working tree (tracked or untracked non-ignored changes) fails the run with `WORKTREE_FAILED`. The executor runs in the worktree and inspection exposes its path and branch while materialized. Cleanup runs when the agent settles, stops, or the manager reconciles an interrupted record. After successful cleanup, the public and persisted worktree path, branch, and cleanup context are removed; if cleanup fails, all of that metadata is retained for a later retry. A run ID keeps concurrent worktrees separate even when their names are the same.

## Agent options, roles, and settings

`subagents_run` accepts the same execution options as a workflow `agent(...)`: model, thinking level, tool, skill, and extension selectors, named roles or inline role overrides, worktrees, structured output, retries, and timeout. The extension also reuses workflow model aliases, settings, resource selector policy, and role discovery:

- global roles: `<agentDir>/pi-extensible-workflows/roles/<name>.md`, normally `~/.pi/agent/pi-extensible-workflows/roles/`;
- trusted project roles: `<cwd>/.pi/pi-extensible-workflows/roles/<name>.md`;
- global and trusted project settings: the normal workflow settings path under the agent directory and `<cwd>/.pi/pi-extensible-workflows/settings.json`.

The current Pi model, thinking level, active tools, project trust, session ID, role definitions, aliases, and resource policy are captured from the extension context for each run. Internal workflow and subagent control tools are not exposed to the child agent.

## Programmatic host integration

Pi discovers this extension through the core package's `pi.extensions` manifest. The manifest entry point is `subagents/index.ts` in the core package; Pi loads this TypeScript entry directly. The following host-integration sketch is pseudocode; Pi supplies `pi` and a host may supply the optional manager:

```ts
import extension, { type SubagentManager } from "./index.js";

const manager: SubagentManager = /* host implementation, or omit this option */;
extension(pi, { manager });
```

The default export registers the five tools. `createSubagentManager()` and `createSubagentTools()` are also exported for hosts that need explicit lifecycle or dependency injection.

## Shutdown and restoration

The default extension subscribes to `session_shutdown`. Disposal aborts active runs, disposes owned agent sessions and listeners, cleans active worktrees, waits for pending completion notifications, releases the storage owner, and is idempotent. Terminal records and results remain on disk. Terminal worktree path, branch, and cleanup context are removed after successful cleanup; failed cleanup retains all three for retry on a later manager startup.

**Cross-session restoration of a live native subagent session is unsupported.** On a new manager, a persisted `running` record is reconciled to `failed` with an interruption error unless a result or failure was already persisted. Use `subagents_retry` to start a new run; it does not restore conversation context or reuse the old native session. Persisted completed and failed records remain readable, subject to the storage owner and filesystem being available.

## Migrating from v5.3 to v5.4

The v5.4 release removes the seven-tool surface's redundant `subagents_list`, `subagents_status`, and `subagents_result` names. There are no compatibility aliases. Replace calls as follows:

| v5.3 call | v5.4 call |
| --- | --- |
| `subagents_run({ prompt, ... })` | unchanged for background runs; `mode: "foreground"` is new |
| `subagents_list({})` | `subagents_inspect({})` |
| `subagents_status({ id })` followed by `subagents_result({ id })` | `subagents_inspect({ id })` |
| `subagents_steer({ id, message })` | unchanged |
| `subagents_stop({ id })` | unchanged |
| `subagents_retry({ id })` | unchanged; the original launch mode is preserved |

The standalone manager deliberately keeps durable run IDs, repeatable inspection, bounded steering, named worktree cleanup, and workflow role/settings reuse.
