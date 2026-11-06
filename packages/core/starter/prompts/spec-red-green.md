---
description: Run a pinned specification through RED, implementation, GREEN, and verdict coverage
argument-hint: "<spec path> <worktree> <RED command> <GREEN command>"
---

Run the bundled `specRedGreen` workflow for this task. Do not implement it yourself.

The function reads and parses the pinned spec, asks for human approval of its requirement ids, runs RED before delegation, gives the writer the spec and worktree by reference, runs GREEN, and checks that every requirement has a task-linked pass verdict with non-blank evidence. It keeps the per-requirement evidence in the result.

The approval decision, the choice of commands and worktree, and the meaning or sufficiency of evidence remain human decisions. A failing RED proves only that the command fails, not that it fails for the intended reason. This function does not prove that tests are complete, that the writer's evidence is truthful, or that unrelated regressions and operational risks are absent.

Launch it with the `specRedGreen` workflow and report the returned verdicts and problems.

Arguments:

$@
