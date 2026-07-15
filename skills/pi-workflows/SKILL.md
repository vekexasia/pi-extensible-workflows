---
name: pi-workflows
description: Use when the task is complex enough to require multiple subagents or when the user explicitly asks for a workflow.
---

# pi-workflows

Use `workflow` exclusively multi-agent work, ordinary tools for one quick operation. Once the task and its phases are clear, the next tool call must be `workflow`; never inspect targets delegated to agents.

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

const failures = reports.filter((result) => !result.ok);
if (failures.length) return { ok: false, failures };

const summary = await agent(
  prompt("Use only these reports:\n\n{reports}", { reports }),
  { name: "summary", tools: [] },
);
return summary;
```

Pass downstream only needed results. Workflow JavaScript has no imports, filesystem, network, process, or timers; delegate such work to agents with the required tools.

## Rules

- Inline workflows and top-level agents need stable names. `parallel(operationName, tasksRecord)` task keys and `pipeline(operationName, itemsRecord, stagesRecord)` item/stage keys are names; one agent call per task/stage may inherit the nearest key, but additional calls need explicit names.
- Runs default to background; set tool-call `foreground: true` when asked to wait.
- `parallel()`/`pipeline()` return railway results. Check `ok`; failures do not cancel siblings. Await results before use.
- Interpolate results with `prompt("...{value}", { value })`; placeholders in plain strings stay literal.
- A specified launch/session model overrides routing tables for every agent. Omit `model` unless the user explicitly requests per-agent routing.
- Set only roles the user requests. Grant minimum tools; pure synthesis needs `tools: []`.
- With `outputSchema`, agents must call `workflow_result`. Retry only idempotent work; add timeouts only when needed.
- Put `isolation: "worktree"` on top-level file-changing agents. Use `checkpoint()` only for human gates. `phase()` is optional.
