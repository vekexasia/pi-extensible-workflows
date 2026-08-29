---
description: Get a second opinion on a plan, design, or decision from an oracle subagent
argument-hint: "<plan, decision, or question>"
---

Get a second opinion before committing to this plan or decision. Do not judge it yourself.

Use `subagents_run` with `role: "oracle"` and `mode: "foreground"`. Give it the proposal below plus the relevant context from this conversation: the goal, the constraints, and any decisions already made. Point it at the files involved instead of pasting file contents.

When it returns, relay the strongest challenge, the hidden assumptions, and the recommendation. State plainly whether the oracle endorsed the proposal.

Proposal:

$@
