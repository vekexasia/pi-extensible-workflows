---
description: Launch a read-only scout subagent to recon the codebase
argument-hint: "<question or area to explore>"
---

Launch one subagent with the `scout` role to answer this recon question. Do not explore the codebase yourself.

Use `subagents_run` with `role: "scout"`, `mode: "foreground"`, and a prompt containing the question below plus any paths or constraints already known in this conversation.

When it returns, relay the brief as-is: relevant files, flow, patterns to reuse, and open questions. Do not pad it.

Question:

$@
