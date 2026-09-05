# Changelog
## Unreleased

## [5.13.0] - 2026-09-05

### Breaking changes

- Worktrees (`withWorktree()` and `subagents_run({ worktree })`) now branch from the launch repository's clean `HEAD` instead of a synthetic runtime snapshot commit. A dirty launch working tree (tracked or untracked non-ignored changes) fails worktree creation with `WORKTREE_FAILED`; commit or stash first. (#235, #262)

### Fixes

- A workflow that fails while bridge work is still in flight now aborts that work (shell, agent, checkpoint, function, worktree) instead of letting it run on after the run is marked failed. (#266)
- Host text blocks truncate by terminal display width, so CJK and other wide characters no longer overflow the line. (#267)
- Lifecycle transitions persist the run's current budget runtime; after `workflow_resume` with a replacement budget, the adjusted usage and budget events are no longer overwritten by the pre-adjustment runtime. (#269)
- The public `pi-extensible-workflows/trajectory` entry can find its UI assets: they are staged next to the bundled entry, not only next to the detached server, so `exportTrajectoryRunHtml` works from the installed package. (#272)
- Trajectory recognizes failed tool results stored in the canonical Pi shape (`message.isError`) in the timeline, the tool summary pane, and the event ticks. (#276)
- `piewf export --bundle` forwards an explicit `--approve` or `--no-approve` to bundle creation, so trust-dependent project resources (roles, extensions) are included or excluded as requested. (#268)
- Portable bundles keep extensions that import the workflow API under an alias (`import { registerWorkflowExtension as register }`): the generated shim exports the original names. (#275)
- `@piewf/cli` declares its Pi and TypeBox runtime dependencies directly instead of as peers, so a Pi-managed install without workspace hoisting loads `piewf`. The packed-package verification now runs the installed CLI as a smoke test. (#273)
- "Change model" in the provider-failure recovery dialog opens the model picker again on Pi 0.85 (`ModelSelectorComponent` constructor changed). A failing recovery dialog now appends its cause to the reported agent error instead of being swallowed. (#260)
- Aligned Pi development dependencies at `0.85.0`. `@earendil-works/pi-server` is a core devDependency because `pi-coding-agent@0.85.0` imports it without declaring it; `@piewf/cli` now declares it as well (#273). (#260)

## [5.12.0] - 2026-09-04

### Runtime

- Persistent agent handles: `agent.create({ name, ... })` returns a handle whose `send(prompt, { outputSchema?, timeoutMs? })` keeps one agent's transcript across turns. Each turn is journaled at `agent/handle/<name>/turn:<n>`, continues from a per-turn copy of the previous session file, and replays without contacting the model.

### Fixes

- Foreground workflow completion is delivered on a single path, removing duplicate background completion messages.
- Bundled roles are recognized across install layouts.
- Registered function side-effect failures are owned by the registered function and fail-fast side-effect errors are preserved.
- Trajectory timeline events link to their transcript rows, and the transcript cursor stays in sync on hover.

## [5.11.2] - 2026-08-31

### Fixes

- Keep Trajectory live state below the WebSocket frame cap, fetch transcript bodies on demand, and reconnect detached servers after publisher disconnects. Restart existing Pi processes after upgrading so their Trajectory publisher uses the new protocol.
## [5.11.1] - 2026-08-30

### Fixes

- Keep streamed reasoning and response progress out of workflow and subagent status, persistence, and exports, and sanitize live activity before terminal rendering.
- Keep Herdr's working state aligned with workflow lifecycle transitions, including pauses, checkpoints, terminal runs, and concurrent runs.

## [5.11.0] - 2026-08-29

### Starter

- New packaged roles: `scout` (read-only recon), `oracle` (second opinion, read-only plus `bash`), and `researcher` (all session tools except `edit`/`write`/`bash`, uses web tools when present), with dynamic `scout-model`, `oracle-model`, and `researcher-model` aliases.
- The packaged `reviewer` role now filters findings on evidence, labels them P0/P1/P2, and ends with a machine-readable merge verdict.
- New package-level slash-command prompts that drive the packaged roles: `/scout`, `/parallel-scout`, `/oracle`, `/council`, `/review`, `/parallel-review`, `/review-loop`, and `/deep-research`. Prompts are declared in the package manifest and are not removed by the starter filter.

### Runtime

- Role frontmatter tools that are not active in the launching session no longer fail the launch with `UNKNOWN_TOOL`. The agent now runs without the missing tool and a warning is surfaced in the TUI (once per role/tool per executor). Call-level `tools`, `effectiveTools`, and boundary checks still fail hard, and doctor diagnostics are unchanged. This makes packaged roles such as `reviewer` work on sessions without the optional `grep`/`find`/`ls` built-ins.

## [5.10.0] - 2026-08-28

### Packaging

- The published package now loads bundled extension entries (`dist/src/index.js`, `dist/starter/index.js`, `dist/subagents/index.js`, `dist/trajectory/index.js`) instead of TypeScript sources, cutting Pi startup overhead from ~1.25s to ~0.06s. Package filters that excluded the old `.ts` entries must switch to the new `dist/*.js` paths (see the extensions guide). Repository-root source installs still load the TypeScript entries.

## [5.9.0] - 2026-08-28

### New capabilities

- Trajectory can export one persisted workflow run as a self-contained static HTML report (`exportTrajectoryRunHtml`): the live UI with inlined assets and injected state instead of a WebSocket, viewable from `file://`, sandboxed iframes, and the `docs/run.html` gist viewer.
- The Trajectory run dossier gains a Share button (and the CLI a `piewf share <run-id>` command) that uploads the static report as a secret GitHub gist through the user's `gh` CLI and returns the viewer URL. Share is served by the Trajectory extension itself; secret gists are unlisted, not private.

### Packaging

- Moved the eval harness from `src/` to the unpublished `evals/src/` directory and stopped publishing `evals/` cases and `test/fixtures` in the npm package. `npm run evals` and `npm run evals:ambient` are unchanged for repository checkouts.

### Fixes

- Closing the workflow dashboard after a confirmed stop now leaves the parent Pi session ready for its next prompt, and intentional cancellation skips provider recovery ([#241](https://github.com/vekexasia/pi-extensible-workflows/issues/241)).
- Live Herdr handoffs show queued/opening status and bypass provider recovery only when a handoff was actually attempted, preserving genuine provider errors containing `abort` ([#204](https://github.com/vekexasia/pi-extensible-workflows/issues/204), [#240](https://github.com/vekexasia/pi-extensible-workflows/pull/240)).

## [5.8.0] - 2026-08-23

### Breaking changes

- Require every workflow agent to submit its result through `workflow_result`. Unstructured agents use `{ result: string }`, return that string to their parent, and fail with `RESULT_INVALID` after the existing two result prompts when they do not submit one. Eager transports now receive the runtime-generated workflow prompt when their session is created.

### New capabilities
- Trajectory now publishes current-session durable subagents as first-class publisher state, including live progress, attempts, transcripts, results, failures, worktrees, and resolved tools.

- Registered-function `context.invoke(name, input, label?)` now supports presentation-only nested breadcrumbs without changing journal identity ([#223](https://github.com/vekexasia/pi-extensible-workflows/issues/223)).
- Trajectory adds a resizable, scrollable workflow Gantt with sticky time axis and independently collapsible Gantt, agent, and log sections, with layout state persisted in local storage ([#224](https://github.com/vekexasia/pi-extensible-workflows/issues/224)).
- Trajectory replaces a stale detached server when its server or UI files change, so `/workflow trajectory` and auto-attach use the current implementation ([#226](https://github.com/vekexasia/pi-extensible-workflows/issues/226)).
- Trajectory groups live sessions by full project folder in a collapsible, dense sidebar with persisted folder state ([#227](https://github.com/vekexasia/pi-extensible-workflows/issues/227)).
- Trajectory auto-attaches without opening a browser once per interactive Pi session when persisted workflow runs are restored or after the first successful workflow launch; `/workflow trajectory` remains the manual browser re-open ([#217](https://github.com/vekexasia/pi-extensible-workflows/issues/217)).
- Trajectory records per-tool wall-clock execution timing in workflow-agent session JSONL and displays completed and failed tool durations across its event, agent, inspector, and Gantt views. Loaded transcripts retain up to 400 non-timing entries plus their matching timing entries ([#212](https://github.com/vekexasia/pi-extensible-workflows/issues/212)).
- Trajectory renders canonical skill file reads as compact `[skill] name:start-end` event previews while retaining their full input in the inspector ([#215](https://github.com/vekexasia/pi-extensible-workflows/issues/215)).
- Trajectory renders tool event arguments as colored key/value pairs with bounded row values while retaining full input for search and inspection ([#222](https://github.com/vekexasia/pi-extensible-workflows/issues/222)).
- Trajectory summarizes assistant tool calls as separate event chips and inspector blocks with searchable arguments ([#220](https://github.com/vekexasia/pi-extensible-workflows/issues/220)).

### Packaging
- Moved Trajectory's server and controller into the bundled extension; the core entry no longer exports `createTrajectoryController`, `createTrajectoryRunLoader`, `createTrajectorySubagentLoader`, `loadTrajectoryRuns`, `openTrajectoryUrl`, `trajectoryUrl`, or the Trajectory contract types.

### Fixes
- Sanitize Trajectory markdown before rendering assistant messages and system prompts.
- Keep Trajectory layout and sidebar preference storage failures from stopping the UI, preserving defaults.
- Exclude non-message session records from Trajectory agent transcripts instead of labeling them assistant messages.
- Ensure idle Trajectory servers destroy connected client sockets before closing, remove their lock, and exit.
- Recover from live but unhealthy Trajectory server locks by replacing the stale process after the startup budget expires.
- Give Trajectory server frame-size and fingerprint configuration separate, unambiguous options.
- Restore Trajectory home, run, and agent views from `?view=&run=&agent=` on refresh and Back ([#228](https://github.com/vekexasia/pi-extensible-workflows/issues/228)).
- Fetch one agent transcript on demand when combined Trajectory state exceeds the WebSocket frame cap, so agent views keep their events.
- Label canonical Trajectory skill reads as `SKILL` in event and inspector views while retaining the tool inspector panes ([#219](https://github.com/vekexasia/pi-extensible-workflows/issues/219)).
- Drop disconnected Trajectory publishers and their runs, returning an open session to the empty home view ([#218](https://github.com/vekexasia/pi-extensible-workflows/issues/218)).
- Collapse shadowed model aliases to the static settings winner in the LLM-facing workflow catalog index and detail results while preserving full provenance for trusted catalogs ([#210](https://github.com/vekexasia/pi-extensible-workflows/issues/210)).
- Clarify Trajectory message token usage as per-call provider input/output (with optional reasoning and cache rows) or a displayed-text estimate, without duplicating it in the header ([#221](https://github.com/vekexasia/pi-extensible-workflows/issues/221)).

### Documentation

- Document how to disable the bundled `reviewLoop` starter, Subagents, and Trajectory independently with Pi package filters.

## [5.7.0] - 2026-08-20

### New capabilities

- Added the bundled `reviewLoop` starter, packaged developer and reviewer roles, and durable standalone subagent tools to the core package.
- Added Trajectory, a local browser UI opened with `/workflow trajectory` for inspecting live workflow runs, agents, transcripts, tools, skills, and extensions.

### Packaging

- Moved standalone subagents into core and stopped publishing `@piewf/subagents` as a separate package.

## [5.6.1] - 2026-08-19

### Fixes

- Wait for background workflow log entries and completion follow-ups instead of a 100ms spin.


## [5.6.0] - 2026-08-18

### Breaking changes

- Removed per-call `thinking`. Concrete models must be `provider/model:thinking`; aliases may omit the suffix and inherit it from the target. Role-file `thinking` frontmatter is rejected.
- `role` is now a name string only. Role files provide defaults; per-call `AgentOptions` `model`, `tools`, `skills`, `extensions`, and `contextFiles` override them. Role objects, `RoleOverride`, `ROLE_OVERRIDE_KEYS`, and `validateRoleOverride` are removed. `overrideSystemPrompt` remains role-file only. Persisted legacy role objects are rejected as corrupt. Legacy role snapshots fold `thinking` into `model`.
- Removed the optional `singleAgent` workflow-catalog function from `@piewf/subagents`. Use core `agent()` and `withWorktree()` in workflow scripts.

### New capabilities

- Added terminal-run retention settings (`retention.olderThanDays`, `retention.maxTerminalRuns`) applied best-effort at session start to hard-terminal runs only.

### Fixes

- Report failed ownership writes per run instead of crashing the host.
- Keep nested `failedAt` paths absolute and journal-consistent.
- Resolve real-session trace paths from the package root.

### Documentation

- Documented agent session transitions and tightened the root README.

## [5.5.0] - 2026-08-16

- Show the core package's bundled changelog once after its installed version changes, with a startup fallback for `pi update --extensions` and `pi update --all` ([#208](https://github.com/vekexasia/pi-extensible-workflows/issues/208)).
- Added `piewf doctor --json`, which emits one machine-readable `DoctorReport` object when checks complete; the existing exit contract still returns non-zero for error diagnostics. Selecting a role adds `roleTarget` and, when role inspection succeeds, `roleInspection` ([#207](https://github.com/vekexasia/pi-extensible-workflows/issues/207)).
- Replaced `disabledAgentResources` with ordered direct `skills`, `extensions`, and `tools` selectors composed across settings, roles, and agent calls; candidates remain enabled unless a matching rule disables them, and `!*` clears a selection before narrower additions. Existing plain positive lists no longer restrict the candidate set; prepend `!*` to preserve a whitelist, and use `!*` (not `[]`) to select none. The legacy `disabledAgentResources` field is rejected by runtime configuration, and `piewf doctor` reports active uses as errors and warns with `AGENT_RESOURCE_TOOL_SELECTOR_ALLOWLIST` when a positive-only tool selector restricts nothing ([#205](https://github.com/vekexasia/pi-extensible-workflows/issues/205), [#206](https://github.com/vekexasia/pi-extensible-workflows/issues/206)).
- Resolved relative extension selectors from their own source: settings selectors from the settings file's directory, role-file selectors from the role file's directory, and call and role-override selectors from the agent launch cwd. Setup hooks may now only narrow resources; widening fails with `INVALID_METADATA` ([#205](https://github.com/vekexasia/pi-extensible-workflows/issues/205)).
- Added fail-closed role-load diagnostics to `piewf doctor`: it reports the source diagnostic and `ROLE_LOAD_BLOCKED`, marks active role entries unavailable in the general report, and exits non-zero ([#205](https://github.com/vekexasia/pi-extensible-workflows/issues/205)).
- Moved Herdr configuration to `extensionSettings.herdr`; the obsolete `extensions.herdr` settings shape is rejected with `INVALID_SETTINGS` and must be migrated ([#205](https://github.com/vekexasia/pi-extensible-workflows/issues/205)).

## [5.4.0] - 2026-08-12

### Subagents API and migration

- Consolidated the `@piewf/subagents` model-facing API to `subagents_run`, `subagents_inspect`, `subagents_steer`, `subagents_stop`, and `subagents_retry`; replace `subagents_list({})` with `subagents_inspect({})` and replace `subagents_status({ id })` or `subagents_result({ id })` with `subagents_inspect({ id })` ([#198](https://github.com/vekexasia/pi-extensible-workflows/issues/198)).
- Added foreground standalone subagent runs with durable terminal envelopes, cancellation persistence, retry-mode preservation, and duplicate follow-up suppression; background remains the default, while optional `singleAgent` workflow composition remains inline and does not create a durable standalone run.
- Added bounded retry metadata and cumulative per-run accounting across internal attempts.

### Subagents TUI and inspection

- Added compact call, progress, inspection, and control renderers plus a bounded background-run widget with stale-run warnings, sub-cent cost display, and width-safe rendering.
- Added the read-only `/subagents` TUI picker for durable current-session runs, with live refresh, persisted labels and roles, inline steering, lifecycle controls, and shared workflow-agent actions for Herdr, editor, IDs, branches, and worktrees.
- Consolidated inspection snapshots under `progress`, removed system prompts and redundant usage fields from public inspection output, and kept legacy persisted records readable ([#200](https://github.com/vekexasia/pi-extensible-workflows/issues/200)).

### Workflow progress and navigation

- Separated repeated registered-function invocations into stable occurrence-aware progress groups such as `developUntilApproved #2`, including nested calls, navigator views, and replay/resume ([#199](https://github.com/vekexasia/pi-extensible-workflows/issues/199)).
- Reworked the background workflow widget to mount once, animate only active runs, rescan at a slower cadence, repaint navigation and elapsed clocks immediately, and suspend while `/workflow` owns the TUI ([#202](https://github.com/vekexasia/pi-extensible-workflows/issues/202)).
- Collapsed durable workflow receipts to one line by default, while expanded receipts retain phases, agents, accounting, errors, and run IDs.
- Added explicit live run-state labels, compact token and cost totals, shared sub-cent cost formatting, and expanded per-agent model, usage, runtime, and retry details.

### Reliability and integrations

- Accepted a submitted `workflow_result` even when the provider emitted an empty abort immediately afterward, avoiding an unnecessary recovery prompt.
- Reported workflow confirmation dialogs as blocked activity so Herdr and other lifecycle observers can represent waits for human input.
- Kept `piewf doctor` read-only by preventing Pi model discovery from writing a model cache.

### TypeScript and maintenance

- Exported shared workflow/subagent presentation helpers and `formatCost` from the core package.
- Split the persistence implementation into focused decoder, path, I/O, session-lease, and store modules without changing its public facade, and deduplicated shared domain and persistence helpers.
- Aligned Pi development dependencies at `0.84.1`.

### Documentation

- Reworked the main README as the canonical product and package overview, added dedicated Subagents and Herdr HTML guides, and connected package selection, roles, settings, installation, and extension references across the documentation site.

## [5.3.0] - 2026-08-09

### New capabilities

- Added a built-in background workflow widget with live phase/agent status and durable transcript receipts; resumable runs remain visible, receipts are written only from stable terminal state, and both can be disabled globally with `backgroundWidget: false` ([#197](https://github.com/vekexasia/pi-extensible-workflows/issues/197)).
- Added the `@piewf/subagents` extension with background `subagents_*` controls, durable IDs/results, steering, stopping, retries, named worktrees, progress/accounting, session-shutdown cleanup, and bounded effective workflow concurrency with no launch queue.
- Added the optional `singleAgent` workflow-catalog function for one inline `context.agent` call with the same request normalization; a process-global name collision leaves the standalone tools available.

### Reliability

- Added bounded completion descriptors for results that do not fit, preserved foreground/background completion envelopes, and kept worktree metadata failures from blocking delivery ([#195](https://github.com/vekexasia/pi-extensible-workflows/issues/195)).
- Cleared subagent worktree path, branch, and cleanup metadata from status after successful cleanup while retaining it when cleanup fails.

### Fixes

- Stopped inline workflow and navigator refresh polling after terminal runs and froze terminal snapshots ([#196](https://github.com/vekexasia/pi-extensible-workflows/issues/196)); scroll hints now appear only for overflowing views.

### Herdr

- Propagated provider-recovery blocked state to Herdr lifecycle reporting.

### Packaging and migration

- Added first-class npm discovery, package release checks, publish ordering, shared-version validation, and documentation for `@piewf/subagents`.
- Added `@earendil-works/pi-tui` as a peer dependency of the core and CLI packages for the built-in widget; install it alongside these packages.

## [5.2.0] - 2026-08-06

### Reliability

- Completed local Pi session lifecycle ownership: extension startup/shutdown is balanced for direct and workflow consumers, and Herdr handoff sessions report resume context.

## [5.1.1] - 2026-07-31

### Fixes

- Clarified workflow phase state glyphs while keeping detailed agent activity in the dashboard details.

### Verification

- `npm run check` passes.

## [5.1.0] - 2026-07-31

### New capabilities

- Added role-targeted `piewf doctor --role` inspection of effective agent resources and prepared prompts without provider execution ([#181](https://github.com/vekexasia/pi-extensible-workflows/issues/181)).
- Added `/workflow` as the sole workflow slash-command with contextual run, agent, lifecycle, budget, and checkpoint actions; Enter opens the applicable action picker and `a`/`A` remains available as a legacy shortcut ([#185](https://github.com/vekexasia/pi-extensible-workflows/issues/185), [#188](https://github.com/vekexasia/pi-extensible-workflows/issues/188)).
- Added an interactive startup picker to resume one or all interrupted workflows.
- Added `/workflow background` behavior to move an attached foreground workflow to background delivery without restarting it ([#182](https://github.com/vekexasia/pi-extensible-workflows/issues/182)).
- Added role `contextFiles` policies to scope context visible to workflow agents ([#179](https://github.com/vekexasia/pi-extensible-workflows/issues/179)).
- Added per-call role override objects with inheritance, unsetting, and explicit replacement semantics.
- Added long-running shell progress reporting and inline foreground log rendering while preserving background transcript delivery ([#180](https://github.com/vekexasia/pi-extensible-workflows/issues/180), [#187](https://github.com/vekexasia/pi-extensible-workflows/issues/187)).

### Fixes

- Exported CLI launchers now prefer the configured Pi package installation before resolving a development-workspace package, preserving registered workflow functions when launched from the repository.

### CLI and diagnostics

- Clarified `piewf doctor` output by separating Pi-active tools/resources from workflow-agent resources after `disabledAgentResources`.

### TypeScript API

- Added typed workflow schemas and orchestration results, plus public local Pi/session inspection APIs.

### Herdr

- Kept handed-off and completed workflow sessions inspectable, including correct continuation behavior for already-completed sessions.

### Verification

- `npm run check` passes.

## [5.0.0] - 2026-07-29

### Breaking changes

- Removed the `workflow` argument from the `workflow` tool. Registered catalog functions are now composed inside `script` or `scriptPath` sources, and `args` remains available to pass input to them.
- Workflow launches now require a non-empty `name` and exactly one of `script` or `scriptPath`.
- Removed the exported `launchScriptForSnapshot` helper; persisted runs resume from their stored script source.

### Herdr

- Migrated `@piewf/herdr` to TypeScript and publish its compiled `dist` output.
- Preserved the originating Pi executable and entrypoint during live handoff, and report handoff status in the originating Pi TUI.
- Preserved completed assistant results across handoff and restored opening completed, failed, or cancelled sessions in Herdr panes.

### Runtime and CLI

- Ordered resolved workflow runs by completion time.
- Report missing transcript files explicitly during session inspection.
- Upgraded Pi development dependencies from `0.80.9` to `0.82.1`.

### Verification

- Expanded core, CLI, persistence, replay, recovery, validation, Herdr, and integration coverage; `npm run check` passes.

## [4.0.3] - 2026-07-28

### Fixes

- Reused the workflow progress component for foreground workflow runs.

## [4.0.2] - 2026-07-28

### Packaging

- Added source repository metadata to `@piewf/herdr` so npm can verify its GitHub Actions provenance, and aligned all public packages at `4.0.2`.

## [4.0.1] - 2026-07-28

### New capabilities

- Added `workflow_status({ runId })` summaries and guarded retry/resume recovery with `expectedState` ([#164](https://github.com/vekexasia/pi-extensible-workflows/issues/164), [6aed1fe](https://github.com/vekexasia/pi-extensible-workflows/commit/6aed1fe), [4d783d3](https://github.com/vekexasia/pi-extensible-workflows/commit/4d783d3)).
- Added workflow and per-agent elapsed-time displays ([#158](https://github.com/vekexasia/pi-extensible-workflows/issues/158), [d05d0ea](https://github.com/vekexasia/pi-extensible-workflows/commit/d05d0ea)).
- Added the Herdr workflow extension with live handoff and fully inspectable agent workspaces ([372c3f6](https://github.com/vekexasia/pi-extensible-workflows/commit/372c3f6)).
- Added hostile-CLI and dynamic-model-router examples ([#167](https://github.com/vekexasia/pi-extensible-workflows/pull/167)).

### Fixes

- Preserved completion and failure delivery across resume, cancellation, and terminal-state races ([#163](https://github.com/vekexasia/pi-extensible-workflows/issues/163), [44fc940](https://github.com/vekexasia/pi-extensible-workflows/commit/44fc940), [680e878](https://github.com/vekexasia/pi-extensible-workflows/commit/680e878), [b21ba55](https://github.com/vekexasia/pi-extensible-workflows/commit/b21ba55)).
- Preserved foreground/background mode during TUI recovery ([#166](https://github.com/vekexasia/pi-extensible-workflows/issues/166), [22a8f9f](https://github.com/vekexasia/pi-extensible-workflows/commit/22a8f9f)).
- Fixed macOS path aliases and Herdr pane lifecycle reporting ([#168](https://github.com/vekexasia/pi-extensible-workflows/pull/168), [5ad64ff](https://github.com/vekexasia/pi-extensible-workflows/commit/5ad64ff), [e9f1859](https://github.com/vekexasia/pi-extensible-workflows/commit/e9f1859)).

### Breaking changes

- Removed extension variables. Use registered functions for reusable host-side capabilities and return values ([#155](https://github.com/vekexasia/pi-extensible-workflows/issues/155), [9601654](https://github.com/vekexasia/pi-extensible-workflows/commit/9601654)).
- Removed the Herdr pane `inspect`, `transcript`, and `fork` actions; use the CLI commands where applicable ([50d5791](https://github.com/vekexasia/pi-extensible-workflows/commit/50d5791)).
- Moved `piewf` to `@piewf/cli`; the core package no longer ships that binary ([fa5c1bf](https://github.com/vekexasia/pi-extensible-workflows/commit/fa5c1bf)).

### Packaging

- Converted to npm workspaces and prepared `pi-extensible-workflows`, `@piewf/cli`, and `@piewf/herdr` for publication from the release workflow ([bc37e7f](https://github.com/vekexasia/pi-extensible-workflows/commit/bc37e7f)).

## [3.4.2] - 2026-07-27

### Recovery and navigation

- Local workflow session disposal now waits for all in-flight prompts before releasing native resources ([#147](https://github.com/vekexasia/pi-extensible-workflows/issues/147)).
- Agent system prompts are now opened through Agent actions instead of being rendered directly in the workflow TUI details ([#153](https://github.com/vekexasia/pi-extensible-workflows/issues/153)).

### Verification

- `npm run check` passes.
## [3.4.1] - 2026-07-26

### Recovery and reliability

- Preserve substantive agent reports when Pi auto-compaction emits an empty `aborted` assistant message instead of treating the empty message as a successful result.

### Verification

- Added regression coverage for aborted assistant turns; package tests, lint, and documentation checks pass.

## [3.4.0] - 2026-07-26

### New capabilities

- Added support for launching reviewed workflow JavaScript files with `scriptPath`; file contents are captured at launch for retry and resume ([#145](https://github.com/vekexasia/pi-extensible-workflows/issues/145)).
- Workflow progress now displays runtime and keeps runtime accounting accurate across pauses and resumes ([#150](https://github.com/vekexasia/pi-extensible-workflows/issues/150)).
- Added a `/workflow` action to open agent prompts in the configured external editor while agents are running or settled ([#151](https://github.com/vekexasia/pi-extensible-workflows/issues/151)).
- Registered function launches may use `name` as an optional run label; `workflow` remains the function identity for resume and replay.

### Recovery, reliability, and navigation

- Inline foreground workflow progress now refreshes persisted agent state so stalled-agent warnings remain visible ([#149](https://github.com/vekexasia/pi-extensible-workflows/issues/149)).
- `/workflow` agent actions can now be closed with `h` or the left arrow ([#152](https://github.com/vekexasia/pi-extensible-workflows/issues/152)).

### Verification

- Package check passed: 427 tests, 426 passed, 1 skipped; lint, documentation checks, and package dry-run passed.

## [3.3.0] - 2026-07-26

### New capabilities

- Added per-run summaries and non-TTY/headless run inspection, including best-effort summary projection and journal-derived timestamps ([#129](https://github.com/vekexasia/pi-extensible-workflows/issues/129); [1908ae5](https://github.com/vekexasia/pi-extensible-workflows/commit/1908ae5), [a911588](https://github.com/vekexasia/pi-extensible-workflows/commit/a911588), [d91d29a](https://github.com/vekexasia/pi-extensible-workflows/commit/d91d29a), [6800fdd](https://github.com/vekexasia/pi-extensible-workflows/commit/6800fdd)).
- Added per-agent token and spend accounting to workflow inspection ([#134](https://github.com/vekexasia/pi-extensible-workflows/issues/134); [4bce545](https://github.com/vekexasia/pi-extensible-workflows/commit/4bce545)).
- Added portable workflow bundles with dependency preflight, selected payload resources, skills, extension modules, and self-contained launchers ([#123](https://github.com/vekexasia/pi-extensible-workflows/issues/123); [76dbc40](https://github.com/vekexasia/pi-extensible-workflows/commit/76dbc40), [0d6c91b](https://github.com/vekexasia/pi-extensible-workflows/commit/0d6c91b), [cc81808](https://github.com/vekexasia/pi-extensible-workflows/commit/cc81808)).
- Added workflow-specific `SYSTEM.md` files and role-level system prompt replacement ([#137](https://github.com/vekexasia/pi-extensible-workflows/issues/137); [cc1082e](https://github.com/vekexasia/pi-extensible-workflows/commit/cc1082e), [0ada062](https://github.com/vekexasia/pi-extensible-workflows/commit/0ada062)).
- Added orange stalled-agent warnings after ten minutes without observable session events ([#138](https://github.com/vekexasia/pi-extensible-workflows/issues/138); [30ab4a1](https://github.com/vekexasia/pi-extensible-workflows/commit/30ab4a1), [5577f69](https://github.com/vekexasia/pi-extensible-workflows/commit/5577f69), [4f594ec](https://github.com/vekexasia/pi-extensible-workflows/commit/4f594ec)).
- Added concise human-readable background failure follow-ups and `inspect --failed` for persisted runs ([#130](https://github.com/vekexasia/pi-extensible-workflows/issues/130); [90acffe](https://github.com/vekexasia/pi-extensible-workflows/commit/90acffe), [387643f](https://github.com/vekexasia/pi-extensible-workflows/commit/387643f), [30e67b2](https://github.com/vekexasia/pi-extensible-workflows/commit/30e67b2)).
- Added active shell operations to workflow progress and cleared stale shell activity during recovery ([#141](https://github.com/vekexasia/pi-extensible-workflows/issues/141); [cf62485](https://github.com/vekexasia/pi-extensible-workflows/commit/cf62485), [a7e4386](https://github.com/vekexasia/pi-extensible-workflows/commit/a7e4386)).

### Recovery, reliability, and navigation

- Continued TUI provider retries in the same native session, preserved results, and recovered thrown provider errors before disposal ([#135](https://github.com/vekexasia/pi-extensible-workflows/issues/135); [d75cb5b](https://github.com/vekexasia/pi-extensible-workflows/commit/d75cb5b), [0b09509](https://github.com/vekexasia/pi-extensible-workflows/commit/0b09509), [d7ca8e7](https://github.com/vekexasia/pi-extensible-workflows/commit/d7ca8e7)).
- Preserved registered workflow role definitions across retries ([#136](https://github.com/vekexasia/pi-extensible-workflows/issues/136); [3fcbf76](https://github.com/vekexasia/pi-extensible-workflows/commit/3fcbf76), [1755c30](https://github.com/vekexasia/pi-extensible-workflows/commit/1755c30)).
- Preserved foreground/background launch mode across resume and retry, including detached interactive budget recovery ([#142](https://github.com/vekexasia/pi-extensible-workflows/issues/142); [326f6bc](https://github.com/vekexasia/pi-extensible-workflows/commit/326f6bc), [fa58b94](https://github.com/vekexasia/pi-extensible-workflows/commit/fa58b94), [bfbd909](https://github.com/vekexasia/pi-extensible-workflows/commit/bfbd909)).
- Delivered detached foreground workflow completion and failure follow-ups correctly ([#143](https://github.com/vekexasia/pi-extensible-workflows/issues/143); [3d2a190](https://github.com/vekexasia/pi-extensible-workflows/commit/3d2a190)).
- Improved workflow navigator hierarchy and Back behavior, and added vim key support ([#139](https://github.com/vekexasia/pi-extensible-workflows/issues/139); [0dec3df](https://github.com/vekexasia/pi-extensible-workflows/commit/0dec3df); [#144](https://github.com/vekexasia/pi-extensible-workflows/issues/144); [3b34e78](https://github.com/vekexasia/pi-extensible-workflows/commit/3b34e78)).
- Completed external-editor artifact cleanup ([#133](https://github.com/vekexasia/pi-extensible-workflows/issues/133); [897f8fd](https://github.com/vekexasia/pi-extensible-workflows/commit/897f8fd)).

### Validation and acceptance coverage

- Added trust-boundary adversarial regression coverage ([#128](https://github.com/vekexasia/pi-extensible-workflows/issues/128); [3e5e6a3](https://github.com/vekexasia/pi-extensible-workflows/commit/3e5e6a3)).
- Added targeted recovery-selection, evaluation-argument, and partial-shell retry acceptance coverage ([#132](https://github.com/vekexasia/pi-extensible-workflows/issues/132); [245a956](https://github.com/vekexasia/pi-extensible-workflows/commit/245a956), [458f564](https://github.com/vekexasia/pi-extensible-workflows/commit/458f564), [50581d5](https://github.com/vekexasia/pi-extensible-workflows/commit/50581d5), [63e6901](https://github.com/vekexasia/pi-extensible-workflows/commit/63e6901)).

### Verification

- Package check passed: 405 tests, 404 passed, 1 skipped; lint, documentation checks, package dry-run, and npm publication passed.

## [3.2.0] - 2026-07-25

### Highlights

- Added a phase-first workflow navigator with responsive layouts and external-editor actions for workflow scripts and completed top-level agent results.
- Published a discoverable workflow extension template with a working role, tests, and setup documentation.
- Rejected unsafe concurrent same-callsite `agent()` calls and obvious `Promise.all(...map(agent))` fan-out; use `parallel()` or `pipeline()` for stable identity.
- Hardened worker temporary-path handling, workflow recovery routing, control-error rendering, and artifact navigation.
- Updated the bundled workflow skill to make named inline parallel fan-out followed by a summarizing agent the default path.

## [3.1.0] - 2026-07-24

### Highlights

- Added explicit dry-run-first `doctor cleanup` with age-gated, lease-aware, dependency-safe deletion of old terminal workflow runs.
- Added dynamic workflow model aliases and phase-aware workflow navigator views.

## [3.0.0] - 2026-07-23

### Breaking changes

- Removed persistent workflow conversations. Use independent `agent()` calls and pass completed results explicitly to later prompts.
- Added explicit `workflow_retry({ runId })` for failed runs, with linked child runs, cumulative budgets, structural journal replay, and durable named-worktree lineage.
- Registered function launches now reject a separate `name`; `workflow` is their run name.

## [2.0.0] - 2026-07-23

### Highlights

- Added schema-validated registered functions. Register reusable workflows under `functions`, launch them directly with `{ workflow: "name", args: {...} }`, or compose them with `context.invoke()`.
- Added the headless CLI: `run` launches registered functions, `export` creates executable POSIX launchers, and `transcript` renders saved sessions. Schema-derived flags, JSON input, trust overrides, and `--` passthrough are supported.
- Added the host-mediated `shell(command, options)` primitive with deterministic workflow identity, timeout and environment options, worktree-aware execution, and structured results.
- Added reusable worktrees. `withWorktree` callbacks receive a frozen `{ path, branch }` reference, and `parentRunId` can borrow matching named worktrees from a terminal run.
- Added bounded structured failure diagnostics, provider-failure recovery in the TUI, and Herdr pane inspection and attempt forking.

### Breaking changes
- Inline `workflow` launches require an explicit non-empty `name`; registered function launches may omit `name` and use the registered function name as the run name.
- Registered function launches ignore any separately supplied run name so function identity remains stable.
- Removed registered workflow scripts: `WorkflowExtension.workflows`, `WorkflowScriptDefinition`, `registry.workflow()` / `workflows()`, and `registeredWorkflowDefinitions`.
  - Migrate each workflow to `functions.<name>` with `description`, `input`, `output`, and `run(input, context)`.
  - Launch it with `{ workflow: "name", args: {...} }`.
- Changed `workflow_catalog` to return a compact index by default and removed its `workflows` collection.
  - Use the default call for discovery and `{ "name": "entry" }` for full details.
  - Host integrations should use `workflowCatalogIndex()`, `workflowCatalogDetail()`, or `registeredWorkflowFunctions()`.
- Bumped launch snapshot identity to v5. Cold resume rejects older snapshots, including v4 snapshots using the previous worktree or registered-function naming contracts, with `RESUME_INCOMPATIBLE`.
  - Relaunch affected workflows after updating. Completed runs remain inspectable and deletable.
- Changed budget relaxation to an asynchronous proposal. `workflow_resume` now returns `{ state: "awaiting_approval", proposalId }`.
  - Answer with `workflow_respond` using the returned `proposalId`. Budget tightening still resumes directly.
- `withWorktree` now requires an explicit non-empty name and callback; unnamed scopes are rejected.
- Removed transcript browsing from the navigator.
  - Use `pi-extensible-workflows transcript <session-file>` or Herdr pane actions.

### Other improvements

- Structured `workflow_result` submissions are accepted immediately without an unnecessary repair turn.
- Workflow overlays gained borders and stable compact rendering; agent rows are denser and unused budget rows stay hidden.
- Fixed fullscreen flashing, shell process-tree cleanup, shell RPC size boundaries, running-attempt fork classification, and exported launchers without a global CLI installation.
- Borrowed worktree bindings are persisted, lineage-checked, and fail closed when invalid. Borrowed worktrees are never deleted with the borrowing run.
- Global and trusted-project roles now propagate consistently through CLI launches, nested agents, and cold resume.
- Updated the README, developer and agent documentation, and bundled workflow skill for the CLI, trust model, shell gates, worktree reuse, and v5 snapshot contract.

### Verification

- Full test suite: 270 tests passing.
- Runtime acceptance suite: 24 tests passing.
- Build, lint, documentation checks, and package dry-run passing.

[5.4.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v5.3.0...v5.4.0
[4.0.2]: https://github.com/vekexasia/pi-extensible-workflows/compare/v4.0.1...v4.0.2
[4.0.1]: https://github.com/vekexasia/pi-extensible-workflows/compare/v3.4.2...v4.0.1
[3.4.2]: https://github.com/vekexasia/pi-extensible-workflows/compare/v3.4.1...v3.4.2
[3.4.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v3.3.0...v3.4.0
[3.2.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v1.0.1...v2.0.0
