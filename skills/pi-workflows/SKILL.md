---
name: pi-workflows
description: Use when the task is complex enough to require multiple subagents or when the user explicitly asks for a workflow.
---

# pi-workflows

Use `workflow` exclusively for genuinely multi-agent orchestration. For one agent, use ordinary tools or `Agent` directly. Do not wrap a single agent in a workflow; either define distinct phases with separate responsibilities or do the work yourself. Once the task and phases are clear, the next tool call must be `workflow`; never inspect targets delegated to agents.

## Pattern

```js
const reports = await parallel("parallel-work", {
  scan: () => agent(
    "Read the target; return concise facts for the final agent.",
    { role: "scout", tools: ["read"] },
  ),
  check: () => agent(
    "Run the requested command; report completion.",
    { tools: ["bash"] },
  ),
});

const summary = await agent(
  prompt("Use only these reports:\n\n{reports}", { reports }),
  { name: "summary", tools: [] },
);
return summary;
```

Pass downstream only needed results. Workflow JavaScript has no imports, filesystem, network, process, or timers; delegate such work to agents with the required tools.

## `agent()` options

When calling agent, you can specify options

```typescript
interface AgentOptions {
  name?: string; // Required at top level; may inherit a parallel task or pipeline stage key.
  model?: `${provider}/${model}` | `${provider}/${model}:${thinking}`;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  role?: string; // must be one of the available workflow roles
  tools?: string[]; // [] = no tools; omitted uses role tools when a role is set, otherwise launch tools at top level or the parent's effective tools for nested agents
  outputSchema?: JsonSchema; // optional JSON Schema for the final value
  continueFrom?: string; // Completed agent name or persisted path in this run.
  retries?: number; // Non-negative; use only for safe, repeatable work.
  timeoutMs?: number | null; // Positive milliseconds; null means unlimited.
  isolation?: "worktree"; // Top-level file-changing agents only.
}
```

## Continuation

Use `continueFrom` when the same completed agent should verify remediation against its earlier findings:

```js
const review = await agent(
  "Review the implementation and report actionable findings.",
  { name: "initial-review", role: "reviewer", tools: ["read", "bash"] },
);
return agent(
  "The workspace changed. Verify the fixes against your previous findings.",
  { name: "verify-fixes", continueFrom: "initial-review" },
);
```

A continuation forks the completed agent's native session and inherits its exact model, thinking, tools, role, output schema, cwd, and worktree. Use it to verify existing findings. Use a fresh agent for independent regression review.

## Rules

- Do not create a workflow for one agent. Phases must have distinct work, not ceremonial wrappers around the same task.
- Inline workflows and top-level agents need stable names. `parallel(operationName, tasksRecord)` task keys and `pipeline(operationName, itemsRecord, stagesRecord)` item/stage keys are names; one agent call per task/stage may inherit the nearest key, but additional calls need explicit names.
- `continueFrom` accepts a completed agent's name or persisted path from the same run. Omit configuration overrides unless they exactly match the source.
- A continuation must reread changed sections because prior file contents are stale. It does not replace a fresh final review when independence matters.
- Runs default to background; set tool-call `foreground: true` when asked to wait.
- `parallel()`/`pipeline()` return keyed bare values. Ordinary failures propagate automatically after all siblings settle; await results before use.
- Interpolate results with `prompt("...{value}", { value })`; placeholders in plain strings stay literal.
- A specified launch/session model overrides routing tables for every agent. Omit `model` unless the user explicitly requests per-agent routing.
- Set only roles the user requests. Grant minimum tools; pure synthesis needs `tools: []`.
- With `outputSchema`, agents must call `workflow_result`. Retry only idempotent work; add timeouts only when needed.
- Put `isolation: "worktree"` on top-level file-changing agents. Use `checkpoint()` only for human gates. `phase()` is optional.
