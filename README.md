# pi-extensible-workflows

Deterministic, resumable multi-agent workflow orchestration for Pi.

Documentation: [developers and agents](https://vekexasia.github.io/pi-extensible-workflows/)

Requires Node.js 22.19 or newer. Verified against Pi 0.80.6. This is a trusted Pi extension: installing it grants it the same filesystem and process access as Pi.

## Install

From the private Git repository:

```sh
pi install git:git@github.com:vekexasia/pi-extensible-workflows.git
```

From a local checkout:

```sh
npm ci
npm run check
pi install /absolute/path/to/pi-extensible-workflows
```

For a one-session trial without changing Pi settings:

```sh
pi --no-extensions --extension /absolute/path/to/pi-extensible-workflows/src/index.ts
```

The package registers two tools, `workflow` and the narrow checkpoint response tool `workflow_respond`, plus one singular `/workflow` command.

## Session inspector

Open the read-only terminal inspector with a session ID, or omit it to be prompted:

```sh
npx pi-extensible-workflows inspect [session-id]
# From this checkout after npm run build:
npm run inspect -- [session-id]
```

Use the arrow keys and Enter to select a workflow. The detail view shows cost, models, agents, retries, and each runtime prompt; press `s` for the syntax-highlighted workflow script and `q` to quit.

## Doctor

Run the read-only, non-interactive health check after opening and trusting the project in Pi:

```sh
npx pi-extensible-workflows doctor
```

From an active Pi session, `/workflow doctor` runs the same checks using that session's active tools.

Doctor validates Pi trust/resources, active tools, global and project roles, settings, extension load failures, and registered reusable workflows. It is verbose by default and exits nonzero only for errors. It never installs packages or changes trust; configured extensions still execute as trusted Pi code while being inspected.

## Run a workflow

Call the `workflow` tool with immutable JavaScript source:

```json
{
  "name": "release-check",
  "script": "phase('inspect'); const result = await agent('Inspect the package', { tools: ['read'] }); return { result };",
  "args": { "target": "dist" }
}
```

Runs are backgrounded by default. The initial result contains a run ID; completion or failure arrives as one root-conversation follow-up. Set `foreground: true` to wait and return the final JSON value inline.

Invocation options:

| Option | Type | Meaning |
| --- | --- | --- |
| `name` | string | Required for inline scripts; registered workflows use their registered name |
| `description` | string | Optional human-readable description |
| `script` | string | Immutable workflow source; mutually exclusive with `workflow` |
| `workflow` | string | Registered reusable workflow name as `namespace.name`; mutually exclusive with `script` |
| `args` | JSON value | Available to the script as `args`; defaults to `null` |
| `foreground` | boolean | Wait for completion instead of returning the run ID |
| `concurrency` | integer 1-16 | Per-run active-agent cap |
| `maxAgentLaunches` | positive integer | Total logical agent-launch cap, including nested agents |
A workflow final result and every worker RPC value must be JSON-compatible and at most 10 MB.

## Workflow source contract

Workflow source is plain sandboxed JavaScript. Inline workflows receive their name from the tool call; registered workflows use their registered name:

```json
{
  "name": "release-check",
  "script": "phase('inspect'); return await agent('Inspect the package');",
}
```
`description` is optional tool-call metadata. `phase(name)` is optional progress telemetry and accepts dynamic names.
Preflight is synchronous and runs before a run directory is created. It rejects statically discoverable syntax errors, malformed schemas and agent options, and unavailable models/tools/agent types. Dynamic values are validated again at the host boundary before execution. Direct `agent(...)` calls receive hidden source call-site identities; aliases are rejected. Calls from one source call site must not race outside `parallel` or `pipeline`, whose structural keys keep replay deterministic.

The worker exposes only deterministic data operations plus:

- `args`
- `agent(prompt, options)`
- `prompt(template, values)`
- `parallel(operationName, tasksRecord)`
- `pipeline(operationName, itemsRecord, stagesRecord)`
- `phase(name)`
- `log(message)`
- `checkpoint({ name, prompt, context })`
- `withWorktree(callback)` or `withWorktree(name, callback)`
- registered global functions and variables

Use a shared scope when top-level agents must collaborate in one worktree:

```js
const results = await withWorktree("implementation", async () => parallel("implementation", {
  api: () => agent("Implement the API"),
  tests: () => agent("Add integration tests"),
}));
```

`withWorktree()` returns the callback result and creates its worktree lazily; an empty scope creates none. Concurrent agents share mutable files, so give them non-conflicting work or coordinate explicitly.

`log(message)` appends a TUI-only entry to the main transcript, capped at 4 KB. It does not enter LLM context or trigger a turn. Calls replayed during recovery may appear again.

Clocks, random numbers, timers, environment/process access, imports, `require`, dynamic code generation, filesystem, and network globals are unavailable. Workflow source runs in a permissioned child process with a VM sandbox. Cancellation is immediate; a missing heartbeat for five seconds fails with `WORKER_UNRESPONSIVE`.

## Safe prompt interpolation

Use the sandbox-only `prompt(template, values)` global to synthesize prompts from agent results:

```js
const reports = await parallel("review", {
  api: () => agent("Inspect the API"),
  ui: () => agent("Inspect the UI"),
});
const synthesis = await agent(
  prompt("Combine these keyed reports.\n\nREPORTS:\n{reports}", { reports }),
);
```

Placeholders use `{identifier}` syntax, may repeat, and require an exact matching set of value keys. `{{` and `}}` render literal braces; other braces remain literal. Strings interpolate verbatim; numbers, booleans, `null`, arrays, and plain objects render as formatted JSON.

Missing or unused values fail. Values are checked recursively and reject Promises and thenables, functions, `undefined`, symbols, cycles, non-finite numbers, and non-plain objects with the failing key path. Await every `agent()` call before passing its result to `prompt()` or `JSON.stringify()`; unawaited agent Promises refuse serialization. `prompt()` never awaits values automatically.

Rendered prompts use the existing 10 MB worker RPC boundary; there is no separate prompt limit. The helper adds no filesystem, network, process, timer, import, or dynamic-code access.

## Agents

```js
const text = await agent("Review the implementation", {
  label: "Implementation review",
  model: "openai-codex/gpt-5.6-sol:high",
  role: "reviewer",
  tools: ["read", "grep", "find", "ls"],
});
```

`label` is an optional non-empty display name persisted in workflow runs and used in TUI names and breadcrumbs. If omitted, agents use their role name, or the effective model name for role-less agents.

Role files may add an optional single-line `description` (1-1024 characters):

```yaml
---
description: Reviews code for correctness and regressions
model: anthropic/claude-fable-5
thinking: high
tools: [read, grep, find]
---
```

When the `workflow` tool is active, the main agent sees only the names and descriptions of effective described roles. Project roles replace same-named global roles completely. Role bodies, paths, models, thinking, and tools remain private to role loading and spawned-agent execution.

`role` references markdown roles from `<agentDir>/pi-extensible-workflows/roles/<name>.md` (by default `~/.pi/agent/pi-extensible-workflows/roles/<name>.md`) and `<cwd>/.pi/pi-extensible-workflows/roles/<name>.md`. Set `PI_CODING_AGENT_DIR` to change `<agentDir>`. Project roles override same-named global roles only in a Pi-trusted project. The role body is appended to that agent session's system prompt. Omitted model, thinking, and tools use the launch snapshot or role policy; omitted timeout is unlimited. Overrides cannot exceed the launching Pi session's model/tool boundary. Workflows intentionally do not provide small/medium/big model tiers or phase routing; role policy belongs in Pi custom agent-role markdowns so prompts, tools, model, and thinking stay in one place. `timeoutMs` is opt-in for intentionally bounded work. Use `retries` only for idempotent/read-only work or prompts that prevent duplicate side effects; each retry gets a fresh persisted Pi session but keeps filesystem changes and counts as one logical agent.

Agents return their bare final text or schema-valid JSON value. Workflow source failures are ordinary `Error` instances with stable `code` and `message`; host-facing tool calls reject with `WorkflowError`. Without `outputSchema`, an agent returns its final text. With a plain JSON Schema:

```js
const result = await agent("Count failures", {
  outputSchema: {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
    additionalProperties: false,
  },
});
```

The native agent receives the stable `workflow_result` tool from session creation. Result acceptance starts only after normal task completion; one repair prompt is allowed. Prose is never parsed as structured output.

### Migration

Agent, checkpoint, parallel, and pipeline calls now return bare values: use `result` instead of `result.value`, use `Object.values(reports).filter(...)` for keyed combinator results, and remove `ok`/`error` checks. Catch workflow-source failures as `Error` and inspect `code`/`message`; host-facing `workflow` calls still reject with `WorkflowError`.

Agent calls no longer accept `name` or `continueFrom`. Interrupted runs created with the earlier named-agent identity contract must be relaunched; completed runs remain inspectable.

If a top-level agent includes `agent` in its effective tools, it can create recursively nested children through the separate child-agent `label` API. Children inherit the parent cwd/worktree and cannot escalate tools. Use `withWorktree(name, callback)` for a shared coordinator scope or separate named scopes, and have the coordinator use nested children. Parents release scheduler capacity while waiting; uncollected descendants are cancelled when the parent ends.

## Parallel and pipeline

Object keys are stable task, item, and stage names; the first argument is the stable operation name.

```js
const checked = await parallel("verification", {
  lint: () => agent("Run lint"),
  tests: () => agent("Run tests"),
});

const built = await pipeline(
  "component-pipeline",
  { api: "src/api.ts", ui: "src/ui.ts" },
  {
    normalize: (path) => ({ path }),
    summarize: (entry) => ({ ...entry, checked: true }),
  },
);
```

Results are keyed bare objects in input order:

```js
// checked
{ lint: "...", tests: "..." }

// built
{ api: { path: "src/api.ts", checked: true }, ui: { path: "src/ui.ts", checked: true } }
```

Ordinary branch or item failures do not cancel siblings. The combinator waits for every sibling to settle, then throws the first failure in input-key order with its original `WorkflowError` code and message. A failed pipeline item skips its later stages while other items continue. Run cancellation aborts immediately and cannot be converted into a branch failure.

## Checkpoints

```js
const decision = await checkpoint({
  name: "ship",
  prompt: "Ship this build?",
  context: { commit: args.commit },
});
if (decision !== "approved") return { approved: false };
```

Sandboxed workflow scripts receive `"approved"` or `"rejected"` from direct `checkpoint()`. Registered workflow functions receive a boolean from `WorkflowOrchestrationContext.checkpoint`. Prompt size is limited to 1 KB UTF-8 and serialized context to 4 KB. The run enters `awaiting_input`; answer it with Approve/Reject in `/workflow` or:

```json
{ "runId": "...", "name": "ship", "approved": true }
```

through `workflow_respond`. The first valid response wins. Responses and completed checkpoints are journaled and replay after cold recovery. Foreground checkpoints require a Pi UI that provides `select` (interactive picker); without it the checkpoint fails with `RESUME_INCOMPATIBLE`, and `workflow_respond` alone does not satisfy that requirement.

## Global workflow primitives

Trusted Pi extensions can register discoverable global functions, run-scoped variables, and reusable workflows during extension loading:

```ts
import { registerWorkflowExtension } from "pi-extensible-workflows";

registerWorkflowExtension({
  namespace: "git",
  version: "1.1.0",
  headline: "Git operations",
  description: "Reusable Git workflow primitives",
  functions: {
    reviewRepository: {
      description: "Review the current repository",
      input: { type: "object", properties: { focus: { type: "string" } }, required: ["focus"], additionalProperties: false },
      output: { type: "string" },
      async run(input, { run, agent, prompt }) {
        return agent(prompt("Review {cwd}, focusing on {focus}", { cwd: run.cwd, focus: input.focus }));
      },
    },
  },
  variables: {
    DEFAULT_BRANCH: {
      description: "Repository default branch",
      schema: { type: "string" },
      async resolve(run) { return readDefaultBranch(run.cwd, run.signal); },
    },
  },
  workflows: {
    releaseCheck: {
      description: "Run the repository release checks",
      script: `return reviewRepository({ focus: "release readiness" });`,
    },
  },
});
```

Workflow scripts call functions and read variables directly:

```js
const review = await reviewRepository({ focus: "security" });
return { branch: DEFAULT_BRANCH, review };
```

Registered workflow names are qualified, for example `{ "workflow": "git.releaseCheck" }`; calling `releaseCheck` without its namespace fails. Registration requires a JavaScript-safe namespace, semantic version, descriptions, valid one-object function schemas, valid variable schemas, and local workflow keys without dots. Global names cannot collide with built-in or sandbox-denied names or another extension.
Whenever it is available, `workflow_catalog` returns deterministic, flat metadata for registered functions, variables, and workflows. It never exposes implementations, resolvers, resolved values, or workflow source. Call it once before creating the first workflow for a task, then reuse its exposed functions, variables, and workflows instead of recreating them in the script. Function calls validate input/output, replay completed journal entries, and receive `agent`, `prompt`, `parallel`, `pipeline`, `withWorktree`, `checkpoint`, `phase`, `log`, and `run` through their context. Variables resolve in parallel before a run is persisted and are recomputed on cold resume.

## Lifecycle and recovery

Run states are `queued`, `running`, `pausing`, `paused`, `awaiting_input`, `completed`, `failed`, `stopped`, and `interrupted`. Agent states are `queued`, `running`, `waiting_for_child`, `paused`, `retrying`, `completed`, `failed`, and `cancelled`.

- Manual pause is cooperative: active native operations finish before `paused`.
- Provider limits pause native Pi sessions; explicit resume continues the same session.
- Stop is immediate, cascading, irreversible, and waits for owned agents to terminate.
- Pi shutdown marks active work `interrupted`; no daemon remains and nothing auto-resumes.
- Reopening the original Pi session can explicitly cold-resume an interrupted run.
- Cold resume trusts the currently loaded workflow primitives, recomputes variables, replays completed structural operations, and reruns interrupted parents.
- Completed, failed, and stopped runs are terminal.

## `/workflow`

`/workflow` lists only runs launched from the exact resolved cwd and current Pi session ID. The navigator shows run state, phase, ownership tree, retries, models, token/cost accounting, errors, worktree/branch locations, checkpoints, and native Pi transcript paths.

Available actions depend on state: Pause, Resume, Stop, Approve, Reject, and Delete. Delete is shown only for terminal runs and requires confirmation. It removes verified workflow run metadata, journals, results, worktrees, and branches. Native Pi transcript files remain in Pi session storage.

Direct command forms are also supported:

```text
/workflow doctor
/workflow pause <run-id>
/workflow resume <run-id>
/workflow stop <run-id>
/workflow approve <run-id> <checkpoint>
/workflow reject <run-id> <checkpoint>
/workflow delete <run-id>
```

## Persistence and worktrees

Runs are stored under:

```text
~/.pi/workflows/projects/<cwd-slug>-<cwd-hash>/sessions/<session-id>/runs/<run-id>/
```

Each run also stores `system-prompts.json`. It records the full effective system prompt at every native Pi `agent_start`, after `before_agent_start` extensions have run, with the native `sessionId`, attempt, turn, and SHA-256 digest. This includes role bodies, project instructions, tool guidance, schema follow-up turns, retries, and any extension modifications. Native Pi JSONL transcripts intentionally do not contain system prompts.

The run directory is created with mode `0700` and `system-prompts.json` with mode `0600`. Treat it as sensitive: it may contain private project instructions. Confirmed run deletion removes it with the other workflow artifacts, while native Pi transcripts remain in Pi session storage. Older runs without this file remain readable.

Identity checks use the exact resolved launch cwd and Pi session ID. Immutable snapshots include source, args, settings, models, tools, effective role definitions, and schemas. Native transcripts remain in Pi session storage and their paths are referenced by the run.

`withWorktree(name, callback)` is the canonical worktree API. Use one named scope per parallel branch when branches must remain separate:

```js
const results = await parallel("implementation", {
  api: () => withWorktree("api", () => agent("Implement the API")),
  ui: () => withWorktree("ui", () => agent("Implement the UI")),
});
```

The runtime creates each deterministic owned branch/worktree lazily from the launch tree. It preserves the launch cwd's relative subdirectory and snapshots launch and agent changes with fixed Git identity, message, dates, disabled hooks, and disabled signing. Children and retries reuse the enclosing scope. The caller branch is unchanged; no merge occurs. Worktrees and branches remain until confirmed run deletion. Creation or ownership failure is `WORKTREE_FAILED`; there is no shared-tree fallback.


## Delivery
Background completion sends exactly one follow-up containing the workflow name and result. Messages are capped at 4 KB at a valid UTF-8 boundary and point to the persisted full result when truncated. Changed scoped worktree locations appear only when changes exist. Failure and provider-limit pause messages are minimal; token, cost, model, and agent-count telemetry stays in `/workflow`. Foreground calls keep their tool card live with an animated running indicator, the current phase, the ownership tree, agent states, and each agent's current activity or running tool call.

Background runs also publish extension lifecycle events:

- `workflow:async-started`
- `workflow:async-complete`

Both use the `id`, `runId`, `sessionId`, and `asyncDir` fields familiar from `pi-subagents` lifecycle events. Completion includes `success` and `state` (`complete`, `failed`, or `stopped`). The channel names remain workflow-scoped so installing both extensions cannot create phantom `pi-subagents` jobs.

## Global settings

Optional strict settings live at `<agentDir>/pi-extensible-workflows/settings.json` (by default `~/.pi/agent/pi-extensible-workflows/settings.json`):

```json
{
  "concurrency": 8,
  "maxAgentLaunches": 1000
}
```

Unknown keys or invalid values block new workflow launches, not Pi startup. Invocation options override these defaults. Per-agent `timeoutMs` remains opt-in in `agent(...)`. The session-wide active-agent ceiling is always 16.

## Error contract

Host-facing failures use `WorkflowError` with a stable `code` and message. Workflow source catches ordinary `Error` objects carrying the same fields. Codes are:

```text
INVALID_SETTINGS INVALID_SYNTAX INVALID_METADATA DUPLICATE_NAME
INVALID_SCHEMA REGISTRY_FROZEN GLOBAL_COLLISION MISSING_WORKFLOW UNKNOWN_MODEL UNKNOWN_TOOL UNKNOWN_AGENT_TYPE RUN_LIMIT_EXCEEDED RPC_LIMIT_EXCEEDED AGENT_TIMEOUT AGENT_FAILED
RESULT_INVALID CANCELLED WORKER_UNRESPONSIVE WORKTREE_FAILED RESUME_INCOMPATIBLE
INTERNAL_ERROR
```

Direct calls and combinators return bare values. Failures propagate automatically with their typed code and message after combinators finish ordinary sibling work.

## Deliberate non-goals

- Full conversation replay or live session tailing
- Nested workflow calls, runtime workflow editing/restart/save-as-command, or model-tier/phase-routing abstractions
- Shared mutable stores between agents
- Token/phase budgets, rate sampling, or automatic spend enforcement
- Built-in quality helpers or generic retry/gate abstractions
- Automatic Git merges or worktree cleanup before confirmed deletion
- Tracking or terminating OS processes launched by agents
- Project/folder settings or cross-session/parent-folder run discovery
- Always-visible task panels or a settings editor
## Prompt-to-workflow evaluations

Deterministic eval helpers run captured inline workflow scripts through `runWorkflow` with a fake bridge, so `npm test` and `npm run check` make zero model calls. They assert only the parent Pi session: ordered assistant batches, ordered content parts, parent tool sequences, workflow-call counts, and parent token/cost usage. Captured scripts never launch real workflow agents.

The gated model runner starts one isolated OS process per case, copies the repository into a temporary project, records JSON artifacts under `.tmp/workflow-evals`, enforces per-case cost caps plus a run spend ceiling, and prints a compact summary. The parent uses a capture-only workflow tool that calls the same production validation function as the real tool boundary, returns validation failures for correction, and never creates runs or launches workflow agents. Hidden static criteria select the first production-valid candidate, then one no-tools judge evaluates case-specific semantic criteria. Artifacts retain failed calls, candidate indices, criterion evidence, and raw token, cost, tool, and validation metrics. Model runs have no timeout by default; `--timeout-ms` is available as an explicit opt-in. Configure the provider and model explicitly; neither is guessed:

```sh
npm run evals -- --provider "$PROVIDER" --model "$MODEL" --case direct-answer,parallel
npm run evals -- --provider "$PROVIDER" --model "$MODEL" --spend-ceiling 0.50
```

The runner exposes the repository's exact workflow skill through Pi's normal skill mechanism and gives the parent `read`, `grep`, `find`, and `bash` inside the disposable project. Skill reads, tools used before workflow, and workflow position are recorded as telemetry rather than forced ordering. Existing Pi auth/model files and workflow roles are copied into the private temporary home and deleted with it. Thinking defaults to `off`; `--model`, `--provider`, `--thinking`, `--case`, `--artifacts`, and `--pi` are supported, with optional `--timeout-ms` when a bounded run is desired.

### Add an eval case

Add one `<id>.yaml` file under `evals/cases` using the existing case files as templates. The top-level fields are `id`, `prompt`, `timeoutMs`, `maxCost`, `expectations`, `expectedWorkflowCalls`, and `semanticCriteria`; nested expectation fields are validated strictly, and files load in filename order. Use `$EVAL_MODEL` in prompts or agent model expectations when the case should use the selected model. Case IDs are passed to `--case` as a comma-separated list, for example `--case parallel`. Keep fixtures referenced by prompts under `test/fixtures`; both case YAML and fixtures are included in the npm package.

### Ambient Tier D

The ambient harness is separately opt-in and prepares execution against the launching user's normal Pi home and discovered resources. It creates one temporary committed fixture repository and a disposable git worktree per case; fixtures contain harmless `test` and `lint` scripts, source, tests, config, and a deliberate bug. Artifacts are JSON and cleanup is recorded:

```sh
PI_WORKFLOW_EVAL_AMBIENT=1 npm run evals:ambient -- --provider "$PROVIDER" --model "$MODEL"
```

Tier D keeps normal extension, skill, context, prompt-template, and tool discovery enabled. It explicitly loads the capture extension; Pi 0.80.6 orders CLI extensions before discovered extensions and resolves duplicate tools by first registration, so `workflow` stays capture-only while the rest of the ambient tool surface remains available. Parent tool order, skill reads, workflow calls, cost, and git changes are recorded. No workflow agents launch in this tier; real-agent E2E remains disabled until launch-count clamping is guaranteed. Ambient worktrees and fixture repositories are removed in `finally`, including process failure and timeout paths.

## Development verification

```sh
npm ci
npm run check       # lint, TypeScript build, complete test suite
npm run acceptance  # production-seam acceptance suite
npm pack --dry-run --json
git diff --check
```

The acceptance suite covers worker worktree scopes, structural replay, exact cwd/session separation, nested ownership and permit handoff, retries and schema finalization, parallel and pipeline combinators, lifecycle recovery and checkpoints, deterministic worktrees and deletion, registered extension macros, strict preflight/settings, native Pi session integration, and minimal delivery.
