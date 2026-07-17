# pi-extensible-workflows

![pi-extensible-workflows workflow banner](https://raw.githubusercontent.com/vekexasia/pi-extensible-workflows/main/assets/pi-extensible-workflows-banner.png)

Turn multi-agent tasks into deterministic jobs that fan out in parallel, pause for approval, and resume without rerunning completed work.

[Documentation](https://vekexasia.github.io/pi-extensible-workflows/) | [Developer guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html) | [Agent guide](https://vekexasia.github.io/pi-extensible-workflows/agents.html)

## Install

```sh
pi install npm:pi-extensible-workflows
```

For source installs and local development, see the [installation guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html#installation).

## Quick start

The package registers the `workflow` and `workflow_respond` tools plus the `/workflow` command. Run this first workflow with the `workflow` tool:

```json
{
  "name": "release-check",
  "script": "phase('inspect'); return agent('Inspect the package', { tools: ['read'] });"
}
```

Runs execute in the background by default. Set `foreground: true` to wait for the final JSON value.

Use `parallel()` and `pipeline()` for deterministic fan-out, `withWorktree()` for isolated Git worktrees, and `checkpoint()` for human approval. The complete contracts and examples live in the documentation:

- [Workflow tool and invocation API](https://vekexasia.github.io/pi-extensible-workflows/developers.html#tool-api)
- [Workflow DSL and worktrees](https://vekexasia.github.io/pi-extensible-workflows/developers.html#dsl)
- [Reusable extension primitives](https://vekexasia.github.io/pi-extensible-workflows/developers.html#extensions)
- [Run inspection and recovery](https://vekexasia.github.io/pi-extensible-workflows/developers.html#operations)
- [Agent patterns and model selection](https://vekexasia.github.io/pi-extensible-workflows/agents.html#patterns)
- [Checkpoints](https://vekexasia.github.io/pi-extensible-workflows/agents.html#checkpoints)

### Reusable extension example

Loaded workflow extensions can expose reusable functions. With the review-loop extension loaded:

```json
{
  "name": "review-loop",
  "script": "return developUntilApproved({ task: args.task });",
  "args": { "task": "Implement the requested change" }
}
```

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
