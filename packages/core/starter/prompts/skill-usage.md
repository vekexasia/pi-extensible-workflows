---
description: Follow skills supplied to a unit by path
argument-hint: "<task>"
---

When a unit receives a skill by path, read that file before acting and follow its instructions.
If the path cannot be read, report `skill_resolution: none` instead of inventing the skill's contents.

CRITICAL SUBORDINATION: The starter carries a per-role context policy, and a workflow that applies it passes those skills in the agent call; a workflow that does not apply it passes whatever skills it chooses.
This prompt must never choose, rank, or name skills; where a workflow applies the policy, the policy is authoritative.

Task:

$@

Apply the guidance above to the supplied task.
