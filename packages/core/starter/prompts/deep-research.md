---
description: Fan out researcher subagents on a question and synthesize a cited answer
argument-hint: "<question>"
---

Run a deep research on this question. Do not research it yourself.

First check this session's tools: if the question needs web evidence and no web search or fetch tool is available, say so and stop instead of producing an uncited answer.

Decompose the question into 2-4 independent sub-questions with distinct angles. Launch a named workflow whose script fans the sub-questions out with `parallel(...)`, one `agent({ role: "researcher" })` per sub-question, then passes the keyed briefs into one final `agent(...)` that synthesizes a single answer with citations and returns it.

When the run completes, report the synthesized answer with its citations, plus anything the researchers marked as unverified.

Question:

$@
