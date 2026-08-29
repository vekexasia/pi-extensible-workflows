---
description: Review the current diff or a named target with a fresh reviewer subagent
argument-hint: "[target or focus]"
---

Launch a fresh-context review of the current work. Do not review it yourself and do not edit files.

Use `subagents_run` with `role: "reviewer"` and `mode: "foreground"`. If a target or focus is given below, review that; otherwise review the current uncommitted diff. Tell the reviewer to inspect the repository and diff directly with its own tools, not to rely on this conversation.

When it returns, relay the findings grouped by P0/P1/P2 and the merge verdict. Do not apply fixes unless I ask.

Target or focus:

$@
