---
name: pi-workflows
description: Use when the task is complex enough to require multiple subagents or when the user explicitly asks for a workflow.
---

# pi-workflows

Use `workflow` exclusively for genuinely multi-agent orchestration. For one agent, use ordinary tools or `Agent` directly. Do not wrap a single agent in a workflow; define distinct responsibilities and keep the result flow explicit.

## Pattern

```js
const reports = await parallel("parallel-work", {
  scan: () => agent("Read the target; return concise facts.", { role: "scout", tools: ["read"] }),
  check: () => agent("Run the requested command.", { tools: ["bash"] }),
});
const summary = await agent(
  prompt("Use only these reports:\n\n{reports}", { reports }),
  { tools: [] },
);
return summary;
```

Pass downstream only needed results. Workflow JavaScript has no imports, filesystem, network, process, or timers; delegate such work to agents with the required tools.

## `agent()` options

```typescript
interface AgentOptions {
  model?: `${provider}/${model}` | `${provider}/${model}:${thinking}`;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  role?: string; // one of the available workflow roles
  tools?: string[]; // [] = no tools; omitted uses role or launch tools
  outputSchema?: JsonSchema;
  retries?: number; // non-negative; use for safe, repeatable work
  timeoutMs?: number | null; // positive milliseconds; null means unlimited
  isolation?: "worktree"; // top-level file-changing agents
}
```

Agent calls are unnamed. Direct `agent(...)` calls receive hidden source call-site identity; aliases are unsupported. Calls from one source call site must not race outside `parallel` or `pipeline`, whose structural keys keep replay deterministic.

## Rules

- Do not create a workflow for one agent. Phases must have distinct work.
- `parallel(operationName, tasksRecord)` task keys and `pipeline(operationName, itemsRecord, stagesRecord)` item/stage keys are names.
- Repeated work uses a JavaScript loop; each direct `agent(...)` call receives deterministic call-site and occurrence identity.
- Runs default to background; set tool-call `foreground: true` when asked to wait.
- Omit `maxAgentLaunches` unless an explicit total launch budget is required.
- `parallel()` and `pipeline()` return keyed bare values. Await results before use.
- Interpolate results with `prompt("...{value}", { value })`; placeholders in plain strings stay literal.
- Select the narrowest role and minimum tools. Pure synthesis can use `tools: []`.
- With `outputSchema`, agents must call `workflow_result`. Retry only idempotent work.
- Put `isolation: "worktree"` on top-level file-changing agents. Use `checkpoint()` only for human gates.

If a top-level agent includes `agent` in its effective tools, it can create nested children through the separate child-agent `label` API. Children inherit the parent cwd/worktree and cannot escalate tools. Put one isolated coordinator in a worktree when agents must collaborate on shared files, and have that coordinator use nested children; per-agent worktree isolation remains enabled.
