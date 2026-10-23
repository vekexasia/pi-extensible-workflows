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
- Reuses generic workflow preparation hooks, model aliases, settings including extension-defined namespaces, and agent options: `label`, `model`, `tools`, `skills`, `extensions`, `contextFiles`, `worktree`, `outputSchema`, `retries` (0 through 255), and `timeoutMs`.
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

In Pi's TUI, `/subagents` opens the [agents workspace](https://vekexasia.github.io/pi-extensible-workflows/developers.html#agents) that `/agents` opens, scoped to the durable standalone runs of the current session; it needs only this extension, not the workflow extension. A full-screen view over Pi shows a "Subagents" header with the count of each state and the total cost, and one row per run in the picker's order: running runs first, then failed, stopped, and completed ones, the latest settled first. A run is named by its label, a repeated label carries the short ID, and a run without a label shows its short ID. The selected run's full transcript fills the rest, drawn with Pi's own message and tool components following Pi's display settings and drawing a skill invocation as Pi's chat does, under a title with its position, name, state, model, tokens, and cost. `d` shows the run's details instead and `d` again its transcript: the run ID and the same activity, stall warning, state, model, tools, attempts, duration, cumulative token accounting, cost, and error fields as a `/workflow` agent; a running run shows its live activity, which `subagents_inspect` leaves out. The view refreshes every second while a run is running or the shown transcript is still being read, and every 5 seconds otherwise. Without a run in the session, `/subagents` says "No durable subagent runs in this session." and opens nothing, and the workspace closes with the same notice when an action leaves none. One workspace is open at a time: a second `/subagents` or `/agents` meanwhile says "The agents workspace is already opening or open." Without a UI, `/subagents` reports the run summary; in a non-TUI mode with a UI it opens a picker with the run summary and the bulk deletions. Running background runs show live only in the workflow widget below the editor (quiet while a workspace is open), one row per run with its model, tokens, cost, elapsed time, and quiet or stalled warning. Each background run leaves a receipt in the transcript when it settles. This extension draws no live rows of its own: with the workflow extension not loaded or its `backgroundWidget: false` setting, only those receipts show. Inspection does not launch a new LLM call; lifecycle actions may steer, stop, retry, or delete a run.

The sidebar takes 38% of the width and starts hidden below 80 columns (above the transcript on a portrait terminal); `tab` moves the focus, `↑` and `↓` (also `k` and `j` in the sidebar) select a run or scroll the transcript by a line, `[` and `]` select the previous or next run, a click selects one, `←`, `→`, and `space` fold the group, `s` hides or shows the sidebar, `ctrl+o` expands tool output, page keys, search, and the mouse wheel scroll the transcript, and `esc` or `ctrl+c` leaves. `a` opens the selected node's action menu, and so does `enter` on the Subagents header. A run offers its registered standalone agent actions, `Copy branch` and `Copy worktree path` when it has a worktree, editor controls for the prompt, the live system prompt, and the result, `Steer` and `Stop` while running, `Retry` for failed or stopped runs, `Delete` once settled, `Copy run path`, and `Copy agent ID`; the Subagents header offers `Delete all completed` and `Delete all failed` when such runs exist. In the menu `↑`/`↓` or `k`/`j` move, `enter` runs the selected action, and `esc`, `←`, or `h` close it. The copies and the editors run in place, with their notice in the status row until the next key. Every other action steps aside: the workspace closes, the action runs with Pi's own dialogs (Stop and every deletion ask for confirmation, `Steer` opens Pi's editor), and the workspace opens again on the same run, on the new run after `Retry`, or on the run now at its row after `Delete`, with the action's notices in the status row. A registered standalone agent action (such as Herdr's) runs detached: the workspace opens again at once, its working message shows in the status row until it settles, a later failure is reported as a notice in that row, and its dialogs are refused with a notice. A run whose worktree still awaits cleanup cannot be deleted. A run's session file is read only when its inspected record names the current Pi session, has a safe ID, and, when it records a cwd, names this project; any other run shows "transcript unavailable" and its file is never opened. New records show on the next refresh, and the message a run active in this Pi process is generating streams in live.

## Tools

`subagents_run` accepts additional JSON agent options for loaded preparation hooks; unknown options are ignored when no plugin handles them. The other control-tool schemas are closed objects. The model-visible standalone surface contains exactly these five names:

| Tool | Input schema |
| --- | --- |
| `subagents_run` | `{ prompt: string, mode?: "background" \| "foreground", label?: string, model?: string, tools?: string[], skills?: string[], extensions?: string[], contextFiles?: string[], worktree?: string, outputSchema?: object, retries?: integer 0..255, timeoutMs?: positive integer \| null }` |
| `subagents_inspect` | `{ id?: string, scope?: "session" \| "all" }` |
| `subagents_steer` | `{ id: string, message: string }` |
| `subagents_stop` | `{ id: string }` |
| `subagents_retry` | `{ id: string }` |

`prompt` is the only required `subagents_run` property. `mode` defaults to "background". Resource candidates start enabled, so plain positive top-level selector lists are additive and top-level `[]` adds no matches. Use `["!*", "read", "grep"]` to restrict a selector to those resources, or `["!*"]` to select none. Unknown JSON options are forwarded to enabled plugins. `role` has no core meaning. Concrete models are `provider/model:thinking`. Capability selectors cannot exceed root and parent ceilings. `excludeTools` takes exact tool names removed after preparation hooks, as Pi's `excludeTools` does; patterns and `workflow_result` are rejected with `INVALID_METADATA`, names also remove same-named custom tools, are frozen with the configuration that retries reuse, and names matching no root or custom tool only warn.

`subagents_inspect({})` returns the current Pi session's run summaries ordered by start time; `subagents_inspect({ scope: "all" })` lists every stored run. `subagents_inspect({ id })` returns the detailed lifecycle record, including state, start and finish timestamps, and the live snapshot under `progress`: `state`, cumulative `accounting`, `toolCalls`, `activity`, and `lastEventAt`. The snapshot state never includes the effective system prompt, and inspection has no `usage` field; token totals are derived from accounting. Materialized worktree path and branch are included when available. For completed runs it also includes `value`; for failed runs it includes `error`. A running run has no terminal value yet. Unknown IDs fail with `RUN_NOT_FOUND`.

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

Run records are stored below the agent directory's private `subagents/<id>/` directory, normally `~/.pi/agent/subagents/<id>/`. The record includes the normalized request, its frozen concrete prepared configuration for deterministic retries, and status. A shared storage owner marker uses the process ID, process start, session ID, and token; every running record carries the same manager identity so a live manager does not reconcile another manager's active run.

Inspection is repeatable. Use the list form for ordered summaries and the ID form for one detailed status plus its terminal value or failure information. Progress is retained in memory and is persisted when the executor marks a progress update for persistence. The result and failure files remain available after manager restart.

## Steering and stopping

`subagents_steer` sends a message to a running agent. Messages sent before the executor exposes its steering handler are queued and delivered in order. The queue is bounded at 16 pending messages. Steering a settled, stopped, or unknown run fails; steering never targets a sibling run.

`subagents_stop` aborts only the selected run, clears its steering queue, persists `state: "stopped"`, aborts its active session, and cleans its worktree. Stopping one run does not stop other runs. Use this tool when the desired terminal state is `stopped`; cancelling a foreground `subagents_run` instead records `failed` with `CANCELLED`.

## Retries

`subagents_retry` is available for `failed` and `stopped` runs. It reads the original normalized request and frozen external configuration, then starts a fresh execution with a new UUID. Historic records without that frozen configuration are reported as incompatible rather than retried with current settings. The old record and ID remain available. Completed or currently running runs are not retryable. The retry preserves the original `background` or `foreground` launch mode, so retrying a foreground run returns its new terminal envelope inline.

## Worktrees

Set `worktree` on `subagents_run` to create a named isolated Git worktree for that run. The default adapter uses the core `RunStore`: the worktree branches from the repository's clean `HEAD`, and a dirty working tree (tracked or untracked non-ignored changes) fails the run with `WORKTREE_FAILED`. The executor runs in the worktree and inspection exposes its path and branch while materialized. Cleanup runs when the agent settles, stops, or the manager reconciles an interrupted record. After successful cleanup, the public and persisted worktree path, branch, and cleanup context are removed; if cleanup fails, all of that metadata is retained for a later retry. A run ID keeps concurrent worktrees separate even when their names are the same.

## Agent options, roles, and settings

`subagents_run` accepts the same execution options as workflow agents, plus JSON extension options. Enable the optional `@piewf/pi-ext-roles` extension in the parent Pi session when role behavior is required; core does not discover role files or read shared role settings. [Generic preparation hooks](https://vekexasia.github.io/pi-extensible-workflows/extensions.html#preparation) receive authorized inventories, effective cwd/agentDir/trust, root defaults, immutable original options, and cancellation. Prepared configurations are persisted before execution and reused on retry without resolving external policies again. Lost capabilities or trust fail closed. Internal workflow and subagent control tools remain excluded from the child agent.

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

The standalone manager deliberately keeps durable run IDs, repeatable inspection, bounded steering, named worktree cleanup, and generic workflow preparation and settings reuse.
