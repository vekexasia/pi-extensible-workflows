---
description: Verify that a worktree's Git state matches the tree that was verified
argument-hint: "<worktree> [base ref] [expected digest]"
---

Run the bundled `closureGate` workflow for this task. Do not implement it yourself.

The function observes the named worktree, checks its HEAD, porcelain status, and diff from the selected base ref, then computes a SHA-256 provenance digest. It reports unexpected untracked paths and detects when a replayed verification no longer matches its expected digest. It never commits or pushes.

The choice of worktree, base ref, allowed untracked paths, expected digest, and whether the reported tree is ready for delivery remain human decisions. This function does not judge the meaning of the diff, test completeness, review quality, merge readiness, or deployment safety.

Launch it with the `closureGate` workflow and report the returned head, digest, and problems.

Arguments:

$@
