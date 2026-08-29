---
description: Convene 2-3 oracle advisors with distinct lenses and write a decision memo
argument-hint: "<question or decision>"
---

Convene a bounded advisory council on this decision. You are the supervisor: you pick the lenses, you synthesize, you decide what feedback is valid. Advisors do not talk to each other.

If the question is trivial or already settled, answer directly instead of convening a council.

Pick 2-3 distinct lenses suited to the decision (for example: simplicity and maintenance cost, correctness and failure modes, migration and compatibility risk). Launch a named workflow whose script fans out one `agent({ role: "oracle" })` per lens with `parallel(...)`, each given the decision, the relevant context, and its lens. One pass only; do not run advisor rounds.

Synthesize the returned opinions yourself into a short decision memo: the recommendation, the strongest argument against it, what each lens surfaced, and the decision that remains mine.

Question:

$@
