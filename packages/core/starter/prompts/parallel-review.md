---
description: Adversarial review with parallel fresh reviewers on distinct angles
argument-hint: "[target or focus]"
---

Run an adversarial parallel review of the current work. Do not review it yourself and do not edit files.

If a target or focus is given below, review that; otherwise review the current uncommitted diff.

Choose 2-3 distinct review angles from the actual change (for example correctness and regressions, tests and validation, simplicity and maintainability; add security, performance, or docs when the change calls for it). Prefer three strong reviewers over many vague ones.

Launch a named workflow whose script fans out one `agent({ role: "reviewer" })` per angle with `parallel(...)`, each told its angle and to inspect the repository and diff directly with its own tools. Await the keyed reviews, then synthesize them yourself into:

- fixes worth doing now;
- optional improvements;
- feedback to ignore or defer, with a short reason.

Report the synthesis and each reviewer's merge verdict. Do not apply fixes unless I ask.

Target or focus:

$@
