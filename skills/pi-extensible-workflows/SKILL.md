---
name: pi-extensible-workflows
description: Use when the task is complex enough to require multiple subagents or when the user explicitly asks for a workflow.
---

# pi-extensible-workflows

Use `workflow` exclusively for genuinely multi-agent orchestration. For one agent, use ordinary tools or `Agent` directly. Do not wrap a single agent in a workflow; define distinct responsibilities and keep the result flow explicit.

## Pattern

```js
const reportSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
};

const reports = await parallel("research", {
  first: () => agent("Research the first target.", { role: "scout", outputSchema: reportSchema }),
  second: () => agent("Research the second target.", { role: "scout", outputSchema: reportSchema }),
});

// Add a downstream agent only when synthesis or independent review is a real phase.
return agent(
  prompt("Review these reports:\n\n{reports}", { reports }),
  { role: "reviewer", outputSchema: reportSchema },
);
```

To pass structured input from the main agent, include `args`:
```json
{ "workflow": "workflowName", "args": { "issue": 42 } }
```
Inside the workflow, read `args.issue`; omitted `args` is `null`.
Use `workflow_stop` with the exact run ID to stop an active background run from the current Pi session.
If `workflow_catalog` is available, call it once before creating the first workflow for a task. Use the returned global functions, variables, registered workflows, and configured model aliases as needed for the rest of that task. Alias targets are catalog metadata, not an availability probe. Do not try to reinvent already exposed functions.

Pass downstream only needed results. Workflow JavaScript has no imports, filesystem, network, process, or timers; delegate such work to agents with the required tools. `shell(command, options)` is the explicit trusted host RPC for deterministic command gates. It inherits the workflow or active worktree cwd, merges string-valued `env` overrides, and returns `{ exitCode, stdout, stderr }`; nonzero exits are results, while launch failures and timeouts fail with `SHELL_FAILED`.

Use a bounded verification loop when objective command output controls the gate:
```js
return withWorktree("fix-tests", async () => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const tests = await shell("yarn test", { env: { CI: "1" } });
    if (tests.exitCode === 0) return tests;
    await agent(prompt("Fix these failures:\n\n{output}", { output: tests.stderr || tests.stdout }));
  }
  return shell("yarn test", { env: { CI: "1" } });
});
```
Shell results are journaled only after process exit and RPC validation. A host crash after command side effects but before journaling can rerun the command on resume, so use `shell()` primarily for verification and bounded command gates rather than exactly-once mutations.

## `agent()` options

```typescript
interface AgentOptions {
  label?: string; // optional non-empty display name
  model?: string; // configured alias or provider/model[:thinking]
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  role?: string; // one of the available workflow roles
  tools?: string[]; // [] = no tools; omitted uses role or launch tools
  outputSchema?: JsonSchema;
  retries?: number; // non-negative; use for safe, repeatable work
  timeoutMs?: number | null; // positive milliseconds; null means unlimited
}
```

Extensions may define additional JSON-compatible agent option keys such as `advisor: true`. Core-owned keys still use the validation and role constraints above; extension options are passed to setup hooks and native setup but are not inherited by child agents.

Agent calls are unnamed. Direct `agent(...)` calls receive hidden source call-site identity; JavaScript aliases for workflow calls are unsupported. Calls from one source call site must not race outside `parallel` or `pipeline`, whose structural keys keep replay deterministic.

## Shared worktree scope

Use `withWorktree(callback)` or `withWorktree(name, callback)` when top-level agents should collaborate in one worktree:

```js
const results = await withWorktree("implementation", async () => parallel("implementation", {
  api: () => agent("Implement the API"),
  tests: () => agent("Add integration tests"),
}));
```

The callback result is returned unchanged and the worktree is created only when the first enclosed agent launches. Concurrent agents share mutable files, so give them non-conflicting work or coordinate explicitly.

`parallel()` tasks may call any workflow function, not only `agent()`:

```js
const results = await parallel("checks", {
  security: () => reviewRepository({ focus: "security" }),
  release: () => reviewRepository({ focus: "release readiness" }),
});
```

Use separate named scopes when each parallel branch needs its own worktree:

```js
const results = await parallel("implementation", {
  api: () => withWorktree("api", () => agent("Implement the API")),
  ui: () => withWorktree("ui", () => agent("Implement the UI")),
});
```

Registered extension functions receive `withWorktree` in their context, so they may create a shared scope internally. They can compose other registered functions without importing their source:
```ts
const report = await context.invoke("reviewRepository", { focus: "security" });
```
Their public inputs and outputs must remain JSON; callbacks cannot cross the extension-function boundary.

## Rules

- Do not create a workflow for one agent. Phases must have distinct work.
- Use `log(messageString)` in the script to surface brief status messages to the operator.
- A role owns its execution policy. When `role` is present, do not also set `model`, `thinking`, or `tools`; only task-specific options such as `outputSchema`, retries, timeout, or a `withWorktree` scope may accompany it.
- Use `parallel()` for independent tasks with different flows. Use `pipeline()` when each keyed item passes through the same ordered stages; do not duplicate identical stage chains inside `parallel()` branches.
- Call shapes are `parallel(operationName, tasksRecord)` and `pipeline(operationName, itemsRecord, stagesRecord)`; object keys are stable task, item, and stage names.
- Preserve item metadata in workflow code between pipeline stages instead of requiring agents to echo it through `outputSchema`.
- Repeated work uses a JavaScript loop; each direct `agent(...)` call receives deterministic call-site and occurrence identity.
- Runs default to background; set tool-call `foreground: true` when asked to wait.
- Add `budget` only when the run needs aggregate limits. The only valid dimension names are exactly `tokens`, `costUsd`, `durationMs`, and `agentLaunches` (never `cost`, `duration`, `launches`, or other shorthand). Each dimension is `{ soft?: number, hard?: number }`; `soft` must be less than `hard`.
- A `budget_exhausted` run is resumable through `workflow_resume`: omitted patch values stay unchanged, explicit `null` removes a limit, and tightening resumes directly. A relaxation persists the exact proposal and returns immediately with `{ state: "awaiting_approval", proposalId }`; `workflow_respond` must answer that exact ID, with rejection leaving the run `budget_exhausted` and approval applying the budget and cold-resuming it.
- `parallel()` and `pipeline()` return keyed bare values. Await results before use.
- Interpolate results with `prompt("...{value}", { value })`; placeholders in plain strings stay literal.
- Use `outputSchema` only when another phase must compare, aggregate, or validate the result. Never add it to a final agent whose prose is returned directly. Keep only fields the consumer needs, and avoid repeating the same evidence in multiple schemas.
- With `outputSchema`, agents must call `workflow_result`; one repair prompt is built in. Omit `retries` unless an additional retry is justified and the work is idempotent.
- Do not add "persona" specs to the prompt for agents. Just define the task.
