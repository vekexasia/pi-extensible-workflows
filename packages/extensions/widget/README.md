# @piewf/widget

A live view of workflow runs above the editor, and a durable receipt in the
transcript once each one finishes.

While a run is going, the widget draws it as a tree — phases, the agents inside
them, the model each one is using, tokens and cost as they accrue, and a clock.
When the run ends the widget drops it immediately and writes a receipt into the
transcript instead:

```
✓ smoke 61.2kt · $0.09 · 01:23 · completed
├─ ✓ shell
├─ ✓ llm  61.2kt · $0.09
│  ╰─ ✓ scout fixture-model:medium · $0.09 · 01:02
│       role scout · via scout-model · read grep find ls bash
│       in 60.4kt · out 823t · cache 203.3kt
╰─ ✓ done
```

The split is deliberate. The widget answers *what is happening* and holds
nothing that already happened; the receipt answers *what did it cost and who did
it*, and keeps the answer for the life of the session rather than for a minute.

## Install

```sh
npm install @piewf/widget
```

Then enable it like any other Pi extension. It needs no configuration.

## What the receipt records

Everything the run directory knows and the widget has no room for:

- the phases in order, and which agents ran in each
- per-agent model and thinking level, plus the role and the alias it asked for
- the tools the role granted — the check that a read-only agent really was
- the token split (input, output, cache reads), which is what explains a cheap
  run that looks enormous
- retries, since a run that only succeeded on the third attempt cost three times
  what its final attempt suggests
- the failure reason, when there is one

The run id is only useful when acting on it, so it stays hidden until the entry
is expanded.

## How it stays cheap

Run state arrives as workflow events (`workflow:run-started`,
`workflow:agent-state-changed`, and friends). The numbers behind it live only in
the run's `state.json`, so an event is a signal to re-read rather than the data
itself. Between events nothing is read at all: the repaint timer only turns the
spinner and advances the clocks.

The widget belongs to its session — a run started in another window is another
window's business, and is ignored here.
