---
description: Verify every specification requirement against the full document and evidence
argument-hint: "<spec file or task>"
---
Read the whole spec document, including the user request, `## Specs`, `## Tasks`, and the implementation evidence. Return exactly one verdict for every `S#` requirement.

A requirement must quote the user request verbatim. Never invent an unasked requirement. For each requirement, return its id, one of `pass`, `fail`, or `unverified`, and concise evidence that points to the relevant task, code, or check. Do not omit a requirement or add a verdict for an unknown id.

Spec file or task:

$@
