# Working in this repository

Pi extensions and a CLI for deterministic, resumable multi-agent workflows,
standalone subagents, and run inspection. This is an npm-workspaces TypeScript
repository, not a hosted application.

## Code map

- `packages/core/src/host.ts`: Pi workflow tool entry point; `host-*.ts`: lifecycle, recovery, delivery, and TUI.
- `packages/core/src/execution.ts`: sandboxed JavaScript worker and host RPC; `validation.ts`: preflight.
- `packages/core/src/store.ts`, `decoders.ts`, `io.ts`: run persistence, validation, and atomic writes.
- `packages/core/src/agent-execution.ts`, `runtime/`: Pi agent sessions, scheduling, cancellation, and transports.
- `packages/core/subagents/`: durable standalone agents; `packages/core/trajectory/`: browser run inspector.
- `packages/core/starter/`: reusable workflows, roles, and slash-command prompts.
- `packages/cli/src/`: `piewf` parsing, headless launch, doctor, inspection, and bundles.
- `packages/extensions/herdr/`: optional Herdr integration.
- Tests live beside each package in `test/`; root `package.json` owns verification commands.

## Boundaries

- Workflow JavaScript is sandboxed; registered functions, shell commands, extensions, and transports are trusted host code. Preserve project trust and parent tool ceilings.
- Persisted snapshots and operation identities define recovery. Validate stored data and preserve replay compatibility; external effects before journaling are not guaranteed exactly once.
- Own cancellation and session disposal. Do not declare completion before results and terminal state are persisted and delivered.
- Preserve pre-existing edits. No merge, publish, deployment, or permission changes without authorization; release approvals remain in [RELEASING.md](RELEASING.md).

## Deliver and verify

- Start with one observable user outcome and trace its actual entry point through the necessary worker, host, persistence, and service boundaries. Fix the shared cause, not one caller.
- One owner integrates and verifies. Delegate only bounded independent work that saves effort; no recursive delegation or review loops without new evidence. Separate blockers from optional notes; investigate repeated failures rather than retrying unchanged.
- Use the Node version range in `package.json`, then `npm ci`. Run a focused regression first, then `npm run check`; run `npm run test:packages` for package/resource changes. See the [verification guide](docs/developers.html#evaluation) for scope and focused commands.
- Completion means the requested outcome was exercised, relevant checks passed, and the diff contains only intended work. Report exact failures, skipped checks, and unverified UI/external paths. A green build alone is not runtime evidence.

## Load deeper guidance only when relevant

- [Workflow skill](packages/core/skills/pi-extensible-workflows/SKILL.md): authoring, launching, inspecting, or recovering workflows. Ordinary repository edits do not need orchestration.
- [Developer guide](docs/developers.html): setup, contracts, lifecycle, and debugging. [Extensions](docs/extensions.html), [roles](docs/roles.html), and [subagents](docs/subagents.html) cover their respective APIs.
- Keep API instructions in those sources, task routing in starter prompts, and persona/resource policy in role files. Link instead of copying; manifests and the lockfile own dependency versions.
