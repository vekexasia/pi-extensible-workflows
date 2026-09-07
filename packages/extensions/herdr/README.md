# `@piewf/herdr`

Connect workflow agents to Herdr panes. The extension adds contextual `/workflow` actions for live handoff and completed-session inspection, plus an optional mode that runs every workflow agent in Herdr.

[Full Herdr documentation](https://vekexasia.github.io/pi-extensible-workflows/herdr.html) | [Main package](https://github.com/vekexasia/pi-extensible-workflows#readme) | [Workflow operations](https://vekexasia.github.io/pi-extensible-workflows/developers.html#operations)

## Requirements and installation

- Node.js 22.19 or newer.
- `pi-extensible-workflows` loaded in Pi.
- Pi running inside a Herdr-managed pane.
- Trusted package code and project context.

```sh
pi install npm:pi-extensible-workflows
pi install npm:@piewf/herdr
```

The extension activates only when Herdr is available. It registers workflow attempt actions and a transport setup hook, not model-facing tools. Set `PI_CODING_AGENT_DIR` if the Pi agent directory is not `~/.pi/agent`.

## Available `/workflow` actions

| Action | Available when | Behavior |
| --- | --- | --- |
| Open live session in Herdr pane | The latest attempt has a transferable live session and fully inspectable mode is off. | Suspends local ownership at a turn boundary, opens the same session in Herdr, and returns ownership after handback. |
| Open session in Herdr pane | The latest attempt is completed, failed, or cancelled and has a persisted session reference. | Opens the existing session in a separate Herdr pane for inspection without taking workflow ownership. |

Open `/workflow`, select a run, then select the agent attempt to see the applicable action.

## Fully inspectable mode

Set the global workflow settings file, normally `~/.pi/agent/pi-extensible-workflows/settings.json`:

```json
{
  "extensionSettings": {
    "herdr": {
      "enableFullyInspectableMode": true
    }
  }
}
```

`extensionSettings.herdr` is the only valid location for Herdr configuration. The obsolete `extensions.herdr` object is rejected with `INVALID_SETTINGS`; migrate it before launching.

This setting is global-only: a project-scope value is accepted by the generic workflow settings parser but ignored by Herdr. When enabled globally, every workflow agent launches in a dedicated labeled Herdr workspace and the manual live-session action is hidden. Completed-session inspection remains available.

## Live handoff and ownership

Live handoff pauses the local SDK at a turn boundary while the Herdr pane owns the task. A generated bridge reports Pi's `agent_settled` event directly to the transport, independently of user extension filters and Herdr screen detection. This returns ownership to the local SDK and closes the owned pane; accepting `workflow_result` alone does not end the execution. Pane exit, `/quit`, and cancellation remain fallback paths.

The extension preserves the originating Pi executable and entrypoint, model, tools, role/resource policy, context selection, prompt configuration, custom result tools, and transferable inline extensions. Temporary bridge files use private permissions; files and sockets are cleaned after the pane closes.

## Interruption behavior and limitations

- Herdr's Pi screen detection cannot distinguish an aborted turn from a completed turn.
- In Pi's default keybindings, use double-`Escape` to abort a turn. A single `Ctrl-C` clears the editor and double-`Ctrl-C` exits Pi, so `Ctrl-C` is not a handback signal.
- Lifecycle reports from this extension are advisory when Herdr's built-in Pi integration has authority.
- A live handoff requires a transferable session file and an available originating Pi runtime.
- Inline extension factories are materialized as temporary explicit extensions in the Herdr pane.

## Development

From the repository root:

```sh
npm run build --workspace=packages/extensions/herdr
npm test --workspace=packages/extensions/herdr
npm run lint --workspace=packages/extensions/herdr
```
