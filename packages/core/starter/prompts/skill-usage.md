---
description: Follow skills supplied to a unit by path
argument-hint: "<task>"
---

When a unit receives a skill by path, read that file before acting and follow its instructions.
If the path cannot be read, report `skill_resolution: none` instead of inventing the skill's contents.

CRITICAL SUBORDINATION: Which skills a unit receives is decided by `context-policy.ts` and passed in the agent call.
This prompt must never choose, rank, or name skills; context policy is authoritative.

Task:

$@

Apply the guidance above to the supplied task.
