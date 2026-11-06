---
description: Launch a read-only scout subagent to recon the codebase
argument-hint: "<question or area to explore>"
---

Launch one subagent with the `scout` role to answer this recon question. Do not explore the codebase yourself.

When a workflow applies the role policy, it launches a unit with that role's context files and skill paths. When you write the agent call yourself, pass those values explicitly.

Use `subagents_run` with `role: "scout"`, `mode: "foreground"`, and a prompt containing the question below plus any paths or constraints already known in this conversation.

When it returns, relay the brief as-is: relevant files, flow, patterns to reuse, and open questions. Do not pad it.

Question:

$@
