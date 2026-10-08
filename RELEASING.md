# Releasing

This repository uses npm workspaces. `packages/core` is the publishable
`pi-extensible-workflows` package, `packages/cli` is the publishable
`@piewf/cli` package, and `packages/extensions/herdr` is the publishable
`@piewf/herdr` package; the repository root is private and is never published.
Satellite packages use the `@piewf` scope, while the core package keeps its
established unscoped name. Standalone subagent tools are shipped inside core.

Publishable workspaces use one fixed shared version. Keep the root version and
each publishable workspace version equal, then create the matching `vX.Y.Z`
tag. The publish workflow verifies every package version, runs the root checks,
packs every publishable workspace, then publishes core, CLI, and Herdr.

## Current optional roles verification gate

Core and CLI must install and work without roles. Run `npm run check` and
`npm run test:packages` here; check/package/terminal verification for roles stays
in its independent repository. For paired verification, build and pack current
core, CLI and roles locally, then run
`PI_OFFLINE=1 node scripts/verify-local-roles-adapter.mjs <local-tarball-directory>`.
Never substitute registry roles/workflows artifacts for this paired check.
The current breaking contract removes compatibility paths, APIs and old run
snapshots; users must enable the roles plugin explicitly and start new runs.
Future publication still requires explicit approval. No verification command
constitutes approval to publish.

## Historical independent roles prerequisite (released 6.0.0)

The following sections record the already-published extraction and its approvals,
not the current dependency or compatibility contract.

`@piewf/pi-ext-roles` is a separate sibling repository with its own version and
sole ownership of the `pi-role` binary. It is not a workflow workspace.
`@piewf/pi-ext-roles@0.1.2` is published through GitHub Actions Trusted Publishing
with provenance and has been installed and exercised in an isolated Pi 1.0.2.
Core/CLI now pin that registry version; the root lockfile records its registry URL
and integrity. `npm ci` requires no sibling checkout or local tarball bootstrap.

Independent versions need not match the workflow workspace version. Package
verification downloads the approved registry roles artifact, then installs packed
workflow/CLI/Herdr consumers without staging local dependency paths or explicitly
injecting the roles library into the combined consumer. This verifies automatic
dependency delivery. These checks are not approval to publish workflows. See
[role migration](docs/roles.html#migration) for paths, contribution APIs and global
binary ownership upgrades. The independent package retains a wildcard Pi host peer,
not a bundled host. Verify packed `src/cli-tool-bridge.ts` and
`dist/cli-tool-bridge.js`, native PATH-based help/model/session behavior and
standalone binary ownership. Assert the removed SDK subpath and stale SDK build
artifacts are absent, and independent discovery/configuration/resolved-options
APIs actually return usable options. Roles owns no SDK sessions or lifecycle.
Workflow/subagents apply those options and transport `extensionSettings` themselves
through the existing consumer session/start/hook seam (`session_start`
`event.settings`); independent roles output delivers no special settings event
channel. The CLI deliberately ignores `extensionSettings` and rejects partial
context scopes unless suppressed by native `--no-context-files`.
Native no-tools/wildcard capability regressions are owned by the sibling
local-provider transport suite; do not replace them with argv-only assertions.

## Historical roles extraction: agreed upgrade plan

Ship the extraction in the next workflow **major release**. The removed
`registerWorkflowExtension({ roleDirectories })` contract is a breaking change,
not a transparent upgrade. The independent roles package keeps its own version.
The `6.0.0` release was explicitly approved and published through GitHub Actions.
Core, CLI and Herdr registry versions and provenance were verified. See the
[post-release E2E report](docs/release-6.0.0-verification.md). Future releases
still require explicit publication approval.

### Existing installations

- Users of roles inside workflows/subagents receive the roles library as a core/CLI
  dependency when they upgrade. They do not need to install or enable the standalone
  Pi plugin separately just to keep using workflow roles.
- Legacy global/project role paths and parser/resolver imports remain supported by
  the workflow compatibility adapter. Existing workflow aliases/selectors remain
  consumer overrides. Migration is manual; no user files are rewritten. TUI warnings
  explain migration where legacy role files/settings are actually present. There is
  no removal date for this compatibility yet.
- Extension authors must replace the removed registration field with
  `registerRoleContribution` from the independent package, preserving workflow
  `source` when needed. Portable bundles using the removed field must be re-exported.
- Users of the old global CLI must upgrade `@piewf/cli` before installing
  `@piewf/pi-ext-roles` for `pi-role`. Never recommend `--force` to overwrite the old
  binary. Native `pi-role` needs roles/settings in the new paths; workflow legacy
  discovery does not extend to the standalone launcher.
- Fallback roles no longer choose a model or supply workflow-specific model aliases.
  Document how to configure an explicit role model/shared alias or per-call model;
  do not promise preservation of the old fallback model choice.

### Release checklist

- [x] Prepare major-version changelog and migration notes covering the cases above,
      plus the documented native CLI limits.
- [x] Obtain explicit approval, then publish and verify the independent roles package.
- [x] Replace core/CLI local tarball dependencies with the approved registry version
      and regenerate the root lockfile. Verify packed consumers use no local paths.
- [x] Exercise a real upgrade from released workflow/CLI `5.19.1` to packed candidate
      `6.0.0` in an isolated Pi 1.0.2, preserving legacy user role files/settings.
      Verify local-provider workflow execution, settings delivery, warning/reload,
      model aliases, new-path precedence and explicit/native project trust gates.
- [x] Exercise the global CLI binary handover without forced overwrites and launch
      standalone `pi-role` after manual path/settings migration.
- [x] Verify a migrated contributor and re-exported portable bundle with actual
      local-provider execution.
- [x] Rerun final checks, package verification and isolated native/TUI regressions.
- [x] Obtain the workflow publication approval, publish the shared workspace major,
      and verify registry installation and binaries before announcing availability.

Documentation ownership: the independent package roles guide, linked from its
concise README and included in its tarball, owns role authoring, shared
configuration, contribution/resolution APIs and native CLI contracts.
`docs/roles.html` is the workflow/subagent optional integration guide.
The README is included in the independent tarball; registry docs must be usable
without access to the workflow repository.

For local release checks:

```sh
npm ci
npm run check
npm pack --dry-run --json --workspace=packages/core
npm pack --dry-run --json --workspace=packages/cli
npm pack --dry-run --json --workspace=packages/extensions/herdr
npm run test:packages
# After packing core, CLI and roles locally into the same directory:
PI_OFFLINE=1 node scripts/verify-local-roles-adapter.mjs <local-tarball-directory>
PI_OFFLINE=1 node scripts/verify-pre6-parity.mjs <local-tarball-directory>
```

The obsolete compatibility upgrade script has been removed. The paired harness
uses temporary HOME, agent and install directories, local product tarballs and a
synthetic local provider; it removes the fixture afterward. It does not prove
remote cache hits, paid providers, MCP or Pi 1.0.3. Historical registry/TUI evidence
remains in the post-release report. Core runtime trust remains Pi-owned: a
role-only project directory does not by itself trigger Pi's native trust prompt;
explicit `--no-approve` excludes it.

The core package stages the repository-root `CHANGELOG.md` into the generated, gitignored `packages/core/CHANGELOG.md` during `prepack`. Its `postpack` hook removes that staging copy after `npm pack` completes. Do not use `--ignore-scripts` when packing core: it skips both hooks and the package-local changelog is not staged. Staging refuses to overwrite an existing `packages/core/CHANGELOG.md`; this protects a stale or user-created file. After an interrupted pack, recover from the repository root with:

```sh
node scripts/stage-core-changelog.mjs clean
```

The cleanup command removes the package-local changelog and marker only when the staging marker `.tmp/core-changelog-staged` exists; otherwise it does nothing. If that marker is missing but `packages/core/CHANGELOG.md` remains, delete that file manually before packing again.
