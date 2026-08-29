# pi-extensible-workflows

Deterministic multi-agent workflow orchestration for Pi. Build named jobs that fan out, pause for approval, use isolated worktrees, and recover without rerunning completed work.

<p align="center">
  <img src="https://raw.githubusercontent.com/vekexasia/pi-extensible-workflows/main/assets/banner.svg" alt="Animated workflow: a task fans out to parallel agents, merges into review, and either completes or loops back" width="100%">
</p>

The repository [README](https://github.com/vekexasia/pi-extensible-workflows#readme) is the canonical product overview, package map, and documentation index.

## Install

Requires Node.js 22.19 or newer. This is trusted Pi host code with the same filesystem and process access as Pi.
The core installation includes workflow orchestration, the `reviewLoop` starter for implementation-and-review cycles, packaged `developer`/`reviewer`/`scout`/`oracle`/`researcher` roles with ready-made slash commands (`/scout`, `/oracle`, `/review`, `/parallel-review`, `/review-loop`, `/deep-research`, and more), and durable standalone subagent tools. See the [Subagents guide](https://vekexasia.github.io/pi-extensible-workflows/subagents.html) for the bundled tools.

```sh
pi install npm:pi-extensible-workflows
```

## Quick start

A workflow is a named inline or file-backed JavaScript script. Pi normally writes the script for the current task.

```js
const reports = await parallel("review", {
  api: () => agent("Review the API."),
  tests: () => agent("Review the tests."),
});

return agent(prompt("Summarize these reports:\n\n{reports}", { reports }));
```

Launch with a non-empty `name` and exactly one of `script` or `scriptPath`. Registered functions are available as globals, and JSON-compatible launch values are available through `args`. Runs are backgrounded by default; set `foreground: true` to wait for the final value.

## Programmatic integration

The package exports the workflow registry, runtime, persistence, validation, settings, role, lifecycle, and local Pi session APIs used by trusted hosts and extensions.

Direct consumers of `createLocalPiSession()` receive a session with extensions already bound. Always `await session.dispose()` so `session_shutdown` runs before the native session is released; disposal is idempotent.

## References

- [Canonical overview](https://github.com/vekexasia/pi-extensible-workflows#readme)
- [Developer guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html)
- [Subagents](https://vekexasia.github.io/pi-extensible-workflows/subagents.html)
- [Herdr](https://vekexasia.github.io/pi-extensible-workflows/herdr.html)
- [Roles](https://vekexasia.github.io/pi-extensible-workflows/roles.html)
- [Extension authoring](https://vekexasia.github.io/pi-extensible-workflows/extensions.html)
- [Bundled workflow skill](skills/pi-extensible-workflows/SKILL.md)

## Development

From the repository root:

```sh
npm run build --workspace=packages/core
npm test --workspace=packages/core
npm run lint --workspace=packages/core
```

## License

MIT
