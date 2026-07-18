# pi-extensible-workflows

![pi-extensible-workflows workflow banner](https://raw.githubusercontent.com/vekexasia/pi-extensible-workflows/main/assets/pi-extensible-workflows-banner.png)

Turn multi-agent tasks into deterministic jobs that fan out in parallel, pause for approval, and resume without rerunning completed work.

[Documentation](https://vekexasia.github.io/pi-extensible-workflows/) | [Developer guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html) | [Agent guide](https://vekexasia.github.io/pi-extensible-workflows/agents.html)

Requires Node.js 22.19 or newer. This is a trusted Pi extension with the same filesystem and process access as Pi.

## Install

```sh
pi install npm:pi-extensible-workflows
```

For source installs and local development, see the [installation guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html#installation).

## Capabilities

The main Pi agent acts as the orchestrator: it writes workflow scripts on the fly for each task. Pi extensions can add reusable functions and variables to those scripts, or register complete workflows that can be invoked by name.

A workflow can fan out across specialized agents, combine their results, and resume without rerunning completed work.

```js
const reviews = await parallel("review", {
  correctness: () => agent("Review the current changes for correctness issues."),
  security: () => agent("Review the current changes for security risks.", {
    role: "security-specialist",
  }),
  tests: () => agent("Review the current changes for missing test coverage."),
});

const summary = await agent(
  prompt("Deduplicate and prioritize these findings:\n\n{reviews}", { reviews }),
);

return summary;
```

Learn more about roles, workflow contracts, and extension APIs in the documentation:

- [Workflow tool and invocation API](https://vekexasia.github.io/pi-extensible-workflows/developers.html#tool-api)
- [Global model aliases](https://vekexasia.github.io/pi-extensible-workflows/developers.html#model-aliases)
- [Aggregate run budgets](https://vekexasia.github.io/pi-extensible-workflows/developers.html#budgets)
- [Workflow DSL and worktrees](https://vekexasia.github.io/pi-extensible-workflows/developers.html#dsl)
- [Reusable extension primitives](https://vekexasia.github.io/pi-extensible-workflows/developers.html#extensions)
- [Run inspection and recovery](https://vekexasia.github.io/pi-extensible-workflows/developers.html#operations)
- [Agent patterns and model selection](https://vekexasia.github.io/pi-extensible-workflows/agents.html#patterns)
- [Checkpoints](https://vekexasia.github.io/pi-extensible-workflows/agents.html#checkpoints)

## CLI

```sh
npx pi-extensible-workflows doctor
npx pi-extensible-workflows inspect [session-id]
```

`doctor` validates the installation and active Pi resources. `inspect` opens a read-only terminal view of persisted workflow runs.

## Development

```sh
npm ci
npm run check
npm run acceptance
npm pack --dry-run --json
```

Model-backed evaluations are optional. See the [evaluation guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html#evaluation).

## License

MIT
