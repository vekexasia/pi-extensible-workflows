---
description: Write a traceable specification and task contract for a user request
argument-hint: "<request or spec file>"
---
Read the user request and write the `## Specs` and `## Tasks` sections in the spec document. Do not implement the work.

Every requirement must quote the user request verbatim. Never invent an unasked requirement. Give each requirement a unique `S#` id and write one requirement per line:

```text
## Specs
S1. <verbatim requirement>

## Tasks
T1 <unit of work>. Spec: S1
```

Keep tasks small and link every task to one or more spec ids. Hand the unit work over by reference to the spec file, task id, and spec ids. Do not hand over an unlinked summary.

Request or spec file:

$@
