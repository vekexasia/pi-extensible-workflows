# pi-extensible-workflows

![pi-extensible-workflows workflow banner](https://raw.githubusercontent.com/vekexasia/pi-extensible-workflows/main/assets/pi-extensible-workflows-banner.png)

> There are many workflow extensions but this one is **Yours.**

Turn multi-agent tasks into deterministic jobs that fan out in parallel, pause for approval, and resume without rerunning completed work.

[Documentation](https://vekexasia.github.io/pi-extensible-workflows/) | [Developer guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html) | [Agent guide](https://vekexasia.github.io/pi-extensible-workflows/agents.html)

Requires Node.js 22.19 or newer. This is a trusted Pi extension with the same filesystem and process access as Pi.

## Install

```sh
pi install npm:pi-extensible-workflows
```

For source installs and local development, see the [installation guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html#installation).

## Capabilities

The main Pi agent acts as the orchestrator: it writes workflow scripts on the fly for each task. Pi extensions can add reusable functions and variables to those scripts; every registered function is also directly runnable as a top-level workflow.

Inline workflow launches require a non-empty `name`; registered function launches may omit it and use their registered function name as the run name. Workflow worktree scopes always use the explicit `withWorktree(name, callback)` form.

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
- [Global and project settings](https://vekexasia.github.io/pi-extensible-workflows/developers.html#settings)
- [Aggregate run budgets](https://vekexasia.github.io/pi-extensible-workflows/developers.html#budgets)
- [Workflow DSL and worktrees](https://vekexasia.github.io/pi-extensible-workflows/developers.html#dsl)
- [Reusable extension primitives](https://vekexasia.github.io/pi-extensible-workflows/developers.html#extensions)
- [Run artifacts and lifecycle events](https://vekexasia.github.io/pi-extensible-workflows/developers.html#lifecycle)
- [Run inspection and recovery](https://vekexasia.github.io/pi-extensible-workflows/developers.html#operations)
- [Agent patterns and model selection](https://vekexasia.github.io/pi-extensible-workflows/agents.html#patterns)
- [Checkpoints](https://vekexasia.github.io/pi-extensible-workflows/agents.html#checkpoints)

## Configuration

Global workflow settings live at `~/.pi/agent/pi-extensible-workflows/settings.json` by default and configure concurrency, model aliases, and workflow-agent skill or extension exclusions. Trusted projects can add resource exclusions at `<project>/.pi/pi-extensible-workflows/settings.json`; they cannot override global aliases or concurrency. See [global and project settings](https://vekexasia.github.io/pi-extensible-workflows/developers.html#settings) for the schema and merge rules.

## CLI

```sh
npx pi-extensible-workflows doctor
npx pi-extensible-workflows inspect [session-id]
npx pi-extensible-workflows transcript <session-file>
npx pi-extensible-workflows run <workflow-name> [workflow arguments]
npx pi-extensible-workflows export <workflow-name> [--name <command>] [--output <path>] [--force]
```

`doctor` validates the installation and active Pi resources. `inspect` opens a read-only terminal view of persisted workflow runs. `transcript` renders a session transcript to stdout. `run` derives flat CLI arguments and help from a registered function's input schema. Use `--input '<json>'` for nested or otherwise complex inputs. It executes in the current working directory, writes the final JSON result to stdout, and writes progress and errors to stderr. `export` creates an executable POSIX launcher in `~/.local/bin` by default.
`run` and `export` accept the trust overrides `--approve` and `--no-approve`; the generated launcher forwards its arguments to `run`. `--` ends launcher option parsing, and later tokens are passed to workflow input instead of being interpreted as launcher options.
Launch snapshots use identity version 5. Cold resume rejects older snapshots, including v4 snapshots created with the previous worktree or registered-function naming contracts, with `RESUME_INCOMPATIBLE`; relaunch the workflow instead.

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
