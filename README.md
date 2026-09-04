# pi-extensible-workflows

Deterministic, resumable multi-agent workflow orchestration for Pi.

<p align="center">
  <img src="assets/banner.svg" alt="Animated workflow: a task fans out to parallel agents, merges into review, and either completes or loops back" width="100%">
</p>

[Documentation](https://vekexasia.github.io/pi-extensible-workflows/) | [Developer guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html) | [Subagents](https://vekexasia.github.io/pi-extensible-workflows/subagents.html) | [Herdr](https://vekexasia.github.io/pi-extensible-workflows/herdr.html) | [Roles](https://vekexasia.github.io/pi-extensible-workflows/roles.html) | [Extension authoring](https://vekexasia.github.io/pi-extensible-workflows/extensions.html)

Requires Node.js 22.19 or newer. This is trusted Pi host code with the same filesystem and process access as Pi. Install only code you trust.

## See it

<table>
<tr>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/2f458025-38a5-49de-8fba-9d2fc52c7703" width="100%" controls></video>
<br><b>TUI</b><br>Live tree, cost, and the workflow script while a run is in progress.
</td>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/92de3070-373a-4da2-86c0-cb0c9c0122b8" width="100%" controls></video>
<br><b>Herdr</b><br>Inspect a live workflow agent in its own pane.
</td>
</tr>
<tr>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/e9225bb9-c985-4aec-bc3e-7b6f0e1a6f16" width="100%" controls></video>
<br><b>Trajectory</b><br>Native collapsible Gantt timeline with a separate local Mermaid topology overview of workflow phases, agents, and tools, plus steer/stop on a running subagent.<br><a href="https://vekexasia.github.io/pi-extensible-workflows/run.html#e70aac2bc4e405baae9276e6f262c0f3">Open sample run report</a>
</td>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/f9c3a7a3-2116-429a-9aeb-e166dad0d926" width="100%" controls></video>
<br><b>Configuring</b><br>Model aliases, skills, and extension settings.
</td>
</tr>
<tr>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/eb76bfb7-a44b-4569-8612-b25af52daaf1" width="100%" controls></video>
<br><b>Roles</b><br>Markdown roles for tools, model, and policy.
</td>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/36d9c34c-822f-4e37-bd31-39db16f9b2ed" width="100%" controls></video>
<br><b>Reusable workflows</b><br>Register a callable <code>defineWorkflowFunction</code> and mix shell gates with agents.
</td>
</tr>
</table>

## Install

```sh
pi install npm:pi-extensible-workflows
```

For source installation and local development, see the [installation guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html#installation).

## Quick start

Ask Pi to run a workflow. The main agent writes the script for the current task.

```js
const reports = await parallel("review", {
  api: () => agent("Review the API."),
  tests: () => agent("Review the tests."),
});

return agent(prompt("Summarize these reports:\n\n{reports}", { reports }));
```

Runs are backgrounded by default; set `foreground: true` to wait for the final value. Use `pipeline()` for staged work, `withWorktree()` for isolation, and `checkpoint()` for approval.

## Included capabilities

The single core installation provides workflows, the `reviewLoop` starter for developer-and-reviewer implementation cycles, packaged `developer`/`reviewer`/`scout`/`oracle`/`researcher` roles, and durable standalone subagent tools (`subagents_run`, `subagents_inspect`, `subagents_steer`, `subagents_stop`, and `subagents_retry`). Ready-made slash commands launch them: `/scout`, `/parallel-scout`, `/oracle`, `/council`, `/review`, `/parallel-review`, `/review-loop`, and `/deep-research`. Roles and aliases are overridable; `reviewLoop` is not. The starter, Subagents, and Trajectory can each be disabled with [Pi package filters](https://vekexasia.github.io/pi-extensible-workflows/extensions.html#bundled-filters).

### Companion packages

- [`@piewf/herdr`](https://github.com/vekexasia/pi-extensible-workflows/tree/main/packages/extensions/herdr) (`pi install npm:@piewf/herdr`): workflow-agent sessions in Herdr panes.
- [`@piewf/cli`](https://github.com/vekexasia/pi-extensible-workflows/tree/main/packages/cli) (`pi install npm:@piewf/cli`): the `piewf` command for workflow operations.

## Development

```sh
npm ci
npm run check
```

See [RELEASING.md](RELEASING.md) for the release process.

## License

MIT
