---
description: Implement a task with the developer-and-reviewer loop workflow
argument-hint: "<task> [max iterations]"
---

Run the bundled `reviewLoop` workflow for this task. Do not implement it yourself.

Launch it with the `workflow` tool: a named run whose script returns `await reviewLoop({ task: args.task })`, passing the task below through `args`. If a max iteration count is given, pass `maxIterations` too. Leave the run in the background unless I asked to wait.

When the run completes, report whether the reviewer passed the implementation, how many iterations ran, and any remaining findings.

Task:

$@
