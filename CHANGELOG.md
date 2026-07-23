# Changelog
## Unreleased

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

[3.0.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v1.0.1...v2.0.0
