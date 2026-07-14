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
  "script": "export const meta = { name: 'release-check', description: 'Check a release', phases: ['inspect'] }; phase('inspect'); const result = await agent('Inspect the package', { name: 'package-inspection', tools: ['read'] }); return { result };",
  "args": { "target": "dist" }
}
```

Runs are backgrounded by default. The initial result contains a run ID; completion or failure arrives as one root-conversation follow-up. Set `foreground: true` to wait and return the final JSON value inline.

Invocation options:

| Option | Type | Meaning |
| --- | --- | --- |
| `script` | string | Immutable workflow source; required unless `workflow` is provided |
| `workflow` | string | Registered reusable workflow name as `namespace.name`; required unless `script` is provided |
| `args` | JSON value | Available to the script as `args`; defaults to `null` |
| `foreground` | boolean | Wait for completion instead of returning the run ID |
| `concurrency` | integer 1-16 | Per-run active-agent cap |
| `maxAgents` | positive integer | Logical agent cap, including nested agents |

A workflow final result and every worker RPC value must be JSON-compatible and at most 10 MB.

## Workflow source contract

The first statement must be a metadata export:

```js
export const meta = {
  name: "release-check",
  description: "Check a release",
  phases: ["inspect", "verify"],
  extensions: [{ name: "git", version: "^1.0.0" }],
};
```

`name` and `description` are required non-empty strings. `phases` is optional, unique, and exhaustive: `phase(name)` rejects undeclared phases. `extensions` declares required registered DSL extension versions.

Preflight is synchronous and runs before a run directory is created. It rejects syntax errors, malformed metadata or schemas, missing stable names, undeclared phases, unavailable models/tools/agent types, and missing or incompatible DSL extensions. Duplicate workflow call names are allowed and disambiguated by occurrence order for structural replay.

The worker exposes only deterministic data operations plus:

- `args`
- `agent(prompt, options)`
- `prompt(template, values)`
- `parallel(tasks, operation)`
- `pipeline(items, ...stages, operation)`
- `phase(name)`
- `log(message)`
- `checkpoint({ name, prompt, context })`
- `extensions.<namespace>.<method>(input)`

Clocks, random numbers, timers, environment/process access, imports, `require`, dynamic code generation, filesystem, and network globals are unavailable. Workflow source runs in a permissioned child process with a VM sandbox. Cancellation is immediate; a missing heartbeat for five seconds fails with `WORKER_UNRESPONSIVE`.

## Safe prompt interpolation

Use the sandbox-only `prompt(template, values)` global to synthesize prompts from agent results:

```js
const report = await agent("Inspect role mechanics", {
  name: "role-mechanics",
  schema: reportSchema,
});

const synthesis = await agent(
  prompt("Combine these reports.\n\nREPORT:\n{report}", { report }),
  { name: "synthesis" },
);
```

Placeholders use `{identifier}` syntax, may repeat, and require an exact matching set of value keys. `{{` and `}}` render literal braces; other braces remain literal. Strings interpolate verbatim; numbers, booleans, `null`, arrays, and plain objects render as formatted JSON.

Missing or unused values fail. Values are checked recursively and reject Promises and thenables, functions, `undefined`, symbols, cycles, non-finite numbers, and non-plain objects with the failing key path. Await every `agent()` call before passing its result to `prompt()` or `JSON.stringify()`; unawaited agent Promises refuse serialization. `prompt()` never awaits values automatically.

Rendered prompts use the existing 10 MB worker RPC boundary; there is no separate prompt limit. The helper adds no filesystem, network, process, timer, import, or dynamic-code access.

## Agents

```js
const text = await agent("Review the implementation", {
  name: "review",
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

`name` is required and stable. `role` and the older `agentType` alias reference markdown roles from `~/.pi/piworkflows/roles/<name>.md` and `<cwd>/.pi/piworkflows/roles/<name>.md`; project roles override same-named global roles. The role body is appended to that agent session's system prompt. Omitted model, reasoning, tools, and timeout inherit the launch snapshot. Overrides cannot exceed the launching Pi session's model/tool boundary. Workflows intentionally do not provide small/medium/big model tiers or phase routing; role policy belongs in Pi custom agent-role markdowns so prompts, tools, model, and thinking stay in one place. `timeoutMs` is opt-in for intentionally bounded work. Use `retries` only for idempotent/read-only work or prompts that prevent duplicate side effects; each retry gets a fresh persisted Pi session but keeps filesystem changes and counts as one logical agent.

Without `schema`, an agent returns its final text. With a plain JSON Schema:

```js
const result = await agent("Count failures", {
  name: "count-failures",
  schema: {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
    additionalProperties: false,
  },
});
```

The native agent receives the stable `workflow_result` tool from session creation. Result acceptance starts only after normal task completion; one repair prompt is allowed. Prose is never parsed as structured output.

If a top-level agent includes `agent` in its effective tools, it can create recursively nested children. The child-facing tools are `agent`, `get_subagent_result`, and `steer_subagent`. Children inherit the parent cwd/worktree and cannot escalate tools. Parents release scheduler capacity while waiting; uncollected descendants are cancelled when the parent ends.

## Parallel and pipeline railways

Every operation, task, item, and stage has an explicit stable name.

```js
const checked = await parallel(
  [
    { name: "lint", run: () => agent("Run lint", { name: "lint-agent" }) },
    { name: "tests", run: () => agent("Run tests", { name: "test-agent" }) },
  ],
  { name: "verification" },
);

const built = await pipeline(
  [
    { name: "api", value: "src/api.ts" },
    { name: "ui", value: "src/ui.ts" },
  ],
  { name: "normalize", run: (path) => ({ path }) },
  { name: "summarize", run: (entry) => ({ ...entry, checked: true }) },
  { name: "component-pipeline" },
);
```

Results preserve input order:

```js
{ name: "lint", ok: true, value: "..." }
{ name: "tests", ok: false, failedAt: "verification/tests", error: { code: "AGENT_FAILED", message: "..." } }
```

Ordinary branch failures are contained and do not cancel siblings. Run cancellation aborts the whole combinator and cannot be converted into a branch failure.

## Checkpoints

```js
const approved = await checkpoint({
  name: "ship",
  prompt: "Ship this build?",
  context: { commit: args.commit },
});
```

Checkpoints return only `true` or `false`. Prompt size is limited to 1 KB UTF-8 and serialized context to 4 KB. The run enters `awaiting_input`; answer it with Approve/Reject in `/workflow` or:

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
        const text = await agent("Inspect git status", { name: "git-status" });
        return { clean: String(text).trim() === "clean" };
      },
    },
  },
  workflows: {
    releaseCheck: {
      description: "Reusable release check workflow",
      script: `export const meta={name:'release-check',description:'Check a release'}; return agent('Check release', {name:'release', role:'reviewer'});`,
    },
  },
});
```

A workflow declaring `{ name: "git", version: "^1.0.0" }` can call `extensions.git.status({})`. A caller can also run the registered script directly with `{ "workflow": "git.releaseCheck" }`. Registration requires a unique JavaScript-safe namespace, exact semantic version, headline, descriptions, one-object input schema, output schema, and valid workflow scripts with literal metadata. Input/output are validated, implementations receive only public orchestration functions, and completed calls replay as one journaled macro. Duplicate namespaces fail extension load.

## Lifecycle and recovery

Run states are `queued`, `running`, `pausing`, `paused`, `awaiting_input`, `completed`, `failed`, `stopped`, and `interrupted`. Agent states are `queued`, `running`, `waiting_for_child`, `paused`, `retrying`, `completed`, `failed`, and `cancelled`.

- Manual pause is cooperative: active native operations finish before `paused`.
- Provider limits pause and continue the same native Pi session after explicit resume.
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

Identity checks use the exact resolved launch cwd and Pi session ID. Immutable snapshots include source, args, settings, models, tools, schemas, and extension versions. Native transcripts remain in Pi session storage and their paths are referenced by the run.

Top-level agents may request `isolation: "worktree"`:

```js
await agent("Implement the fix", { name: "implementation", isolation: "worktree" });
```

The runtime creates a deterministic owned branch/worktree, preserves the launch cwd's relative subdirectory, and snapshots launch and agent changes with fixed Git identity, message, dates, disabled hooks, and disabled signing. Children and retries reuse the worktree. The caller branch is unchanged; no merge occurs. Worktrees and branches remain until confirmed run deletion. Creation or ownership failure is `WORKTREE_FAILED`; there is no shared-tree fallback.
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
  "maxAgents": 1000
}
```

Unknown keys or invalid values block new workflow launches, not Pi startup. Invocation options override these defaults. Per-agent `timeoutMs` remains opt-in in `agent(...)`. The session-wide active-agent ceiling is always 16.

## Error contract

Failures use `WorkflowError` with a stable `code` and message. Codes are:

```text
INVALID_SETTINGS INVALID_SYNTAX INVALID_METADATA DUPLICATE_NAME UNKNOWN_PHASE
INVALID_SCHEMA MISSING_EXTENSION INCOMPATIBLE_EXTENSION UNKNOWN_MODEL UNKNOWN_TOOL
UNKNOWN_AGENT_TYPE RUN_LIMIT_EXCEEDED RPC_LIMIT_EXCEEDED AGENT_TIMEOUT AGENT_FAILED
RESULT_INVALID CANCELLED WORKER_UNRESPONSIVE WORKTREE_FAILED RESUME_INCOMPATIBLE
INTERNAL_ERROR
```

Direct `agent()` and extension calls return bare values or throw typed failures. Parallel and pipeline convert ordinary branch failures to railway results.

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

The acceptance suite covers worker isolation, structural replay, exact cwd/session isolation, nested ownership and permit handoff, retries and schema finalization, railway combinators, lifecycle recovery and checkpoints, deterministic worktrees and deletion, registered extension macros, strict preflight/settings, native Pi session integration, and minimal delivery.
