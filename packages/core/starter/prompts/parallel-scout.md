---
description: Fan out scout subagents across areas of the codebase and merge the briefs
argument-hint: "<question or task to scope>"
---

Recon this question across the codebase with parallel scouts. Do not explore it yourself.

If the question is small enough for one scout, launch a single subagent with the `scout` role instead of a workflow.

Otherwise split the question into 2-3 independent areas (for example: the feature's entry points, the data layer it touches, the tests that cover it). Launch a named workflow whose script fans out one `agent({ role: "scout" })` per area with `parallel(...)`, then merge the keyed briefs yourself into one map: relevant files, how the flow works end to end, patterns to reuse, and open questions.

Report the merged brief. Keep it compact; no implementation plan.

Question:

$@
