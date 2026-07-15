# pi-workflows

Deterministic, resumable multi-agent workflow orchestration for Pi.

Requires Node.js 22.19 or newer. Verified against Pi 0.80.6. This is a trusted Pi extension: installing it grants it the same filesystem and process access as Pi.

## Install

From the private Git repository:

```sh
pi install git:git@github.com:vekexasia/pi-workflows.git
```

From a local checkout:

```sh
npm ci
npm run check
pi install /absolute/path/to/pi-workflows
```

For a one-session trial without changing Pi settings:

```sh
pi --no-extensions --extension /absolute/path/to/pi-workflows/src/index.ts
```

The package registers two tools, `workflow` and the narrow checkpoint response tool `workflow_respond`, plus one singular `/workflow` command.

## Doctor

Run the read-only, non-interactive health check after opening and trusting the project in Pi:

```sh
npx pi-workflows doctor
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
| `extensions` | object[] | Optional `{ name, version }` extension requirements |
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
  "extensions": [{ "name": "git", "version": "^1.0.0" }]
}
```

`description` and `extensions` are optional tool-call metadata. `extensions` declares required registered DSL extension versions. `phase(name)` is optional progress telemetry and accepts dynamic names.

Preflight is synchronous and runs before a run directory is created. It rejects statically discoverable syntax errors, malformed schemas and agent options, unavailable models/tools/agent types, and missing or incompatible DSL extensions. Dynamic values are validated again at the host boundary before execution. Direct `agent(...)` calls receive hidden source call-site identities; aliases are rejected. Calls from one source call site must not race outside `parallel` or `pipeline`, whose structural keys keep replay deterministic.

The worker exposes only deterministic data operations plus:

- `args`
- `agent(prompt, options)`
- `prompt(template, values)`
- `parallel(operationName, tasksRecord)`
- `pipeline(operationName, itemsRecord, stagesRecord)`
- `phase(name)`
- `log(message)`
- `checkpoint({ name, prompt, context })`
- `extensions.<namespace>.<method>(input)`

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
  model: "openai-codex/gpt-5.6-sol:high",
  role: "reviewer",
  tools: ["read", "grep", "find", "ls"],
});
```

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

`role` references markdown roles from `~/.pi/piworkflows/roles/<name>.md` and `<cwd>/.pi/piworkflows/roles/<name>.md`; project roles override same-named global roles only in a Pi-trusted project. The role body is appended to that agent session's system prompt. Omitted model, thinking, and tools use the launch snapshot or role policy; omitted timeout is unlimited. Overrides cannot exceed the launching Pi session's model/tool boundary. Workflows intentionally do not provide small/medium/big model tiers or phase routing; role policy belongs in Pi custom agent-role markdowns so prompts, tools, model, and thinking stay in one place. `timeoutMs` is opt-in for intentionally bounded work. Use `retries` only for idempotent/read-only work or prompts that prevent duplicate side effects; each retry gets a fresh persisted Pi session but keeps filesystem changes and counts as one logical agent.

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

If a top-level agent includes `agent` in its effective tools, it can create recursively nested children through the separate child-agent `label` API. Children inherit the parent cwd/worktree and cannot escalate tools. Put one isolated coordinator in a worktree when agents must collaborate on shared files, and have that coordinator use nested children; do not remove per-agent worktree isolation. Parents release scheduler capacity while waiting; uncollected descendants are cancelled when the parent ends.

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

Direct `checkpoint()` returns `"approved"` or `"rejected"`. Prompt size is limited to 1 KB UTF-8 and serialized context to 4 KB. The run enters `awaiting_input`; answer it with Approve/Reject in `/workflow` or:

```json
{ "runId": "...", "name": "ship", "approved": true }
```

through `workflow_respond`. The first valid response wins. Responses and completed checkpoints are journaled and replay after cold recovery. Foreground checkpoints require a Pi UI that provides `select` (interactive picker); without it the checkpoint fails with `RESUME_INCOMPATIBLE`, and `workflow_respond` alone does not satisfy that requirement.

## DSL extensions

Trusted Pi extensions can register validated orchestration macros during extension load:

```ts
import { registerWorkflowDslExtension } from "pi-workflows";

registerWorkflowDslExtension({
  name: "git",
  version: "1.0.0",
  headline: "Git operations",
  description: "Reusable Git workflow macros",
  methods: {
    status: {
      description: "Read repository status",
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { clean: { type: "boolean" } },
        required: ["clean"],
        additionalProperties: false,
      },
      async run(_input, { agent }) {
        const text = await agent("Inspect git status");
        return { clean: String(text).trim() === "clean" };
      },
    },
  },
  workflows: {
    releaseCheck: {
      description: "Reusable release check workflow",
      extensions: [{ name: "git", version: "^1.0.0" }],
      script: `return agent('Check a release', {role:'reviewer'});`,
    },
  },
});
```

A workflow can call `extensions.git.status({})` when the `git` extension is registered. A caller can run the registered script directly with `{ "workflow": "git.releaseCheck" }`. Registration requires a unique JavaScript-safe namespace, exact semantic version, headline, descriptions, one-object input schema, output schema, and valid plain JavaScript workflow scripts. Input/output are validated, implementations receive only public orchestration functions, and completed calls replay as one journaled macro. In extension method context, `checkpoint()` returns a boolean rather than the workflow sandbox's `"approved"` or `"rejected"` string. Duplicate namespaces fail extension load.

## Lifecycle and recovery

Run states are `queued`, `running`, `pausing`, `paused`, `awaiting_input`, `completed`, `failed`, `stopped`, and `interrupted`. Agent states are `queued`, `running`, `waiting_for_child`, `paused`, `retrying`, `completed`, `failed`, and `cancelled`.

- Manual pause is cooperative: active native operations finish before `paused`.
- Provider limits pause native Pi sessions; explicit resume continues the same session.
- Stop is immediate, cascading, irreversible, and waits for owned agents to terminate.
- Pi shutdown marks active work `interrupted`; no daemon remains and nothing auto-resumes.
- Reopening the original Pi session can explicitly cold-resume an interrupted run.
- Cold resume revalidates snapshotted capabilities/extensions, replays completed structural operations, and reruns interrupted parents.
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

Identity checks use the exact resolved launch cwd and Pi session ID. Immutable snapshots include source, args, settings, models, tools, effective role definitions, schemas, and extension versions. Native transcripts remain in Pi session storage and their paths are referenced by the run.

Top-level agents may request `isolation: "worktree"`:

```js
await agent("Implement the fix", { isolation: "worktree" });
```

The runtime creates a deterministic owned branch/worktree from all repository-wide tracked changes, deletions, and nonignored untracked files present at launch, not from clean `HEAD`. It preserves the launch cwd's relative subdirectory and snapshots launch and agent changes with fixed Git identity, message, dates, disabled hooks, and disabled signing. Children and retries reuse the worktree. The caller branch is unchanged; no merge occurs. Worktrees and branches remain until confirmed run deletion. Creation or ownership failure is `WORKTREE_FAILED`; there is no shared-tree fallback.
## Delivery

Background completion sends exactly one follow-up containing the workflow name and result. Messages are capped at 4 KB at a valid UTF-8 boundary and point to the persisted full result when truncated. Changed isolated branch/worktree locations appear only when changes exist. Failure and provider-limit pause messages are minimal; token, cost, model, and agent-count telemetry stays in `/workflow`. Foreground calls keep their tool card live with an animated running indicator, the current phase, the ownership tree, agent states, and each agent's current activity or running tool call.

Background runs also publish extension lifecycle events:

- `workflow:async-started`
- `workflow:async-complete`

Both use the `id`, `runId`, `sessionId`, and `asyncDir` fields familiar from `pi-subagents` lifecycle events. Completion includes `success` and `state` (`complete`, `failed`, or `stopped`). The channel names remain workflow-scoped so installing both extensions cannot create phantom `pi-subagents` jobs.

## Global settings

Optional strict settings live only at `~/.pi/workflows/settings.json`:

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
INVALID_SCHEMA MISSING_EXTENSION INCOMPATIBLE_EXTENSION UNKNOWN_MODEL UNKNOWN_TOOL
UNKNOWN_AGENT_TYPE RUN_LIMIT_EXCEEDED RPC_LIMIT_EXCEEDED AGENT_TIMEOUT AGENT_FAILED
RESULT_INVALID CANCELLED WORKER_UNRESPONSIVE WORKTREE_FAILED RESUME_INCOMPATIBLE
INTERNAL_ERROR
```

Direct calls and combinators return bare values. Failures propagate automatically with their typed code and message after combinators finish ordinary sibling work.

## Deliberate non-goals

- Transcript rendering or a built-in transcript viewer
- Nested workflow calls, runtime workflow editing/restart/save-as-command, or model-tier/phase-routing abstractions
- Shared mutable stores between agents
- Token/phase budgets, rate sampling, or automatic spend enforcement
- Built-in quality helpers or generic retry/gate abstractions
- Automatic Git merges or worktree cleanup before confirmed deletion
- Tracking or terminating OS processes launched by agents
- Project/folder settings or cross-session/parent-folder run discovery
- Always-visible task panels or a settings editor

## Development verification

```sh
npm ci
npm run check       # lint, TypeScript build, complete test suite
npm run acceptance  # production-seam acceptance suite
npm pack --dry-run --json
git diff --check
```

The acceptance suite covers worker isolation, structural replay, exact cwd/session isolation, nested ownership and permit handoff, retries and schema finalization, parallel and pipeline combinators, lifecycle recovery and checkpoints, deterministic worktrees and deletion, registered extension macros, strict preflight/settings, native Pi session integration, and minimal delivery.
