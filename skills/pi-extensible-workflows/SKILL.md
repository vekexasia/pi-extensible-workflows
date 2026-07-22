---
name: pi-extensible-workflows
description: Use when the task is complex enough to require multiple subagents or when the user explicitly asks for a workflow.
---

# pi-extensible-workflows

Use `workflow` only for genuinely multi-agent orchestration; one agent uses ordinary tools or `Agent` directly. Give phases distinct responsibilities and keep result flow explicit.

## Pattern

```js
const reportSchema = { type: "object", properties: { summary: { type: "string" }, findings: { type: "array", items: { type: "string" } } }, required: ["summary", "findings"], additionalProperties: false };

const reports = await parallel("research", {
  first: () => agent("Research the first target.", { role: "scout", outputSchema: reportSchema }),
  second: () => agent("Research the second target.", { role: "scout", outputSchema: reportSchema }),
});

return agent(
  prompt("Review these reports:\n\n{reports}", { reports }),
  { role: "reviewer", outputSchema: reportSchema },
);
```

Pass structured input from the main agent with `args`:
```json
{ "workflow": "workflowName", "args": { "issue": 42 } }
```
Inside the workflow, read `args.issue` (`args` is `null` when omitted). `workflow_stop` requires the exact run ID; foreground results retain their value and completed `runId`, while background launches return `runId` immediately. A terminal `parentRunId` reuses matching named `withWorktree` scopes; unnamed or missing names create new worktrees.

If `workflow_catalog` is available, call it once before creating the first workflow for a task. Use its registered functions, variables, and model aliases; direct function launches use `{ "workflow": "name", "args": { ... } }` and enforce schemas. Alias targets are metadata, not availability probes.

Workflow JavaScript has no imports, filesystem, network, process, or timers. Delegate that work to agents. `shell(command, options)` is the trusted host RPC for deterministic gates: it inherits the workflow or active-worktree cwd, merges string `env` overrides, and returns `{ exitCode, stdout, stderr }`; nonzero exits are results, but launch failures and timeouts fail with `SHELL_FAILED`.

Use a bounded verification loop when command output controls the gate:
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
Shell results are journaled only after process exit and RPC validation. A host crash after side effects but before journaling can rerun the command on resume; use `shell()` mainly for verification and bounded gates, not exactly-once mutations.

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

Extensions may add JSON-compatible agent options such as `advisor: true`; core keys retain validation and role constraints. Extension options go to setup hooks/native setup and are not inherited by child agents.

Agent calls are unnamed. Direct calls receive hidden source call-site identity; aliases are unsupported, and calls from one source site must not race outside `parallel` or `pipeline`, whose structural keys make replay deterministic.

## Worktrees

Use `withWorktree(callback)` or `withWorktree(name, callback)` for top-level agents that collaborate in one worktree:
```js
const results = await withWorktree("implementation", async () => parallel("implementation", {
  api: () => agent("Implement the API"),
  tests: () => agent("Add integration tests"),
}));
```
The callback result is unchanged and the worktree is created only when the first enclosed agent launches. Concurrent agents share mutable files, so assign non-conflicting work or coordinate explicitly.

Branches may call any workflow function, not only `agent()`. Use separate named scopes when parallel branches need isolated worktrees:
```js
const results = await parallel("implementation", {
  api: () => withWorktree("api", () => agent("Implement the API")),
  ui: () => withWorktree("ui", () => agent("Implement the UI")),
});
```

Registered extension functions receive `withWorktree` in context and can compose other registered functions with `context.invoke("reviewRepository", { focus: "security" })`. Their public inputs and outputs remain JSON; callbacks cannot cross the extension boundary.

## Rules

- Use `log(messageString)` for brief operator status.
- A role owns execution policy: with `role`, do not set `model`, `thinking`, or `tools`; only task options such as `outputSchema`, retries, timeout, or a `withWorktree` scope may accompany it.
- Use `parallel()` for independent tasks with different flows and `pipeline()` when every keyed item follows the same ordered stages; do not duplicate identical chains in `parallel()`. Signatures are `parallel(operationName, tasksRecord)` and `pipeline(operationName, itemsRecord, stagesRecord)`; keys are stable task, item, and stage names.
- Preserve item metadata in workflow code between pipeline stages instead of making agents echo it through `outputSchema`.
- Use a JavaScript loop for repeated work; each direct `agent(...)` call gets deterministic call-site and occurrence identity.
- Runs default to background; set tool-call `foreground: true` when asked to wait.
- Add `budget` only for aggregate limits. Valid dimensions are exactly `tokens`, `costUsd`, `durationMs`, and `agentLaunches`; each is `{ soft?: number, hard?: number }` with `soft < hard`.
- `budget_exhausted` runs resume through `workflow_resume`: omitted patch values stay unchanged, `null` removes a limit, and tightening resumes directly. Relaxation stores the exact proposal and returns `{ state: "awaiting_approval", proposalId }`; `workflow_respond` must answer that ID. Rejection leaves the run exhausted; approval applies the budget and cold-resumes it.
- `parallel()` and `pipeline()` return keyed bare values; await them before use. Interpolate results with `prompt("...{value}", { value })`; placeholders in plain strings remain literal.
- Use `outputSchema` only when another phase compares, aggregates, or validates a result, never for final prose. Keep only consumer-needed fields and avoid repeated evidence. Agents with it must call `workflow_result`; one repair prompt is built in. Omit `retries` unless an extra retry is justified and work is idempotent.
- Do not add persona specifications to agent prompts; define the task directly.
