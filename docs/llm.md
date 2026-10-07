# pi-extensible-workflows

> Trusted Pi packages for deterministic workflows, standalone subagents, Herdr integration, reusable roles, and extension capabilities.

This file is the compact package-selection, configuration, extension-authoring, and role-authoring reference for an LLM. It is intentionally not a workflow-language guide. Do not invent workflow scripts, orchestration patterns, or recovery procedures from this file. For workflow authoring, use the bundled skill at `packages/core/skills/pi-extensible-workflows/SKILL.md`.
## Install and trust

Requirements:

- Node.js 22.19 or newer.
- A trusted Pi installation and trusted project. These packages are trusted code with the same filesystem and process access as Pi.

Install the core workflow extension for deterministic orchestration:

```sh
pi install npm:pi-extensible-workflows
```

The core installation includes workflow orchestration, the `reviewLoop` starter, standalone subagent tools, and Trajectory. The starter ships `reviewLoop`, dynamic `developer-model`/`reviewer-model`/`scout-model`/`oracle-model`/`researcher-model` aliases, and slash-command prompts (`/scout`, `/parallel-scout`, `/oracle`, `/council`, `/review`, `/parallel-review`, `/review-loop`, `/deep-research`) that launch subagents or workflows with those roles. Role behavior requires explicitly installing and enabling the independent `@piewf/pi-ext-roles` Pi extension; core and CLI have no roles dependency. Static settings `modelAliases` shadow the dynamic resolvers. `reviewLoop` cannot be overridden: a duplicate name is `GLOBAL_COLLISION`. Disable optional entries with Pi package filters `"-dist/starter/index.js"`, `"-dist/subagents/index.js"`, and `"-dist/trajectory/index.js"`; keep `dist/src/index.js` for workflow tools. Package prompts are declared in the package manifest and are not removed by the starter filter. The same package-root paths apply to `pi install "$PWD/packages/core"`. See `docs/extensions.html#bundled-filters`. Add companion packages only for the capability you need:

```sh
pi install npm:@piewf/herdr
npm install -g @piewf/cli
```

| Package | Select it when |
| --- | --- |
| `pi-extensible-workflows` | The task needs workflows, the `reviewLoop` implementation-and-review starter, or one independent subagent run with a durable ID and lifecycle controls. |
| `@piewf/herdr` | Core workflow agents need live handoff, completed-session inspection, or fully inspectable execution in Herdr. Core must also be loaded. |
| `@piewf/cli` | A terminal needs the `piewf` command for doctor, inspection, headless registered-function or file-backed workflow execution, export, or bundles. Only `piewf` is owned by this package; `pi-role` belongs to the independent `@piewf/pi-ext-roles` package. |

For local development:

```sh
git clone https://github.com/vekexasia/pi-extensible-workflows.git
cd pi-extensible-workflows
npm ci
npm run check
pi install "$PWD/packages/core"
```

A one-session source run is:

```sh
pi --no-extensions --extension "$PWD/packages/core/src/index.ts"
```

Only load extension code and role files that you trust. Workflow scripts run in a separate sandbox; extension factories, registered functions, hooks, and transports run in the trusted host.

## Configuration files

`PI_CODING_AGENT_DIR` changes the Pi agent directory. Otherwise use `~/.pi/agent`.

- Global settings: `<agentDir>/pi-extensible-workflows/settings.json`
- Trusted project settings: `<cwd>/.pi/pi-extensible-workflows/settings.json`

Core reads only workflow settings. Role discovery, shared settings, and file formats belong to the optional roles package; legacy core role paths and APIs are removed.

Missing settings files use defaults. Settings JSON is strict: unknown keys, invalid JSON, and invalid values fail launch or resume. Project settings are ignored when the project is not trusted.

Effective precedence is:

1. Built-in defaults (`concurrency` defaults to `8`; `backgroundWidget` defaults to `true`).
2. Global settings.
3. Trusted project settings, appended after global selectors.
4. Per-agent options and generic preparation hooks, within authorized ceilings.

Selectors are concatenated in that order. A later matching rule wins over earlier rules. Every candidate starts enabled; a matching positive pattern enables it and `!pattern` disables it. `!*` clears the current selection before narrower positive patterns are applied. Candidates with no matching rule remain enabled, and selectors cannot create unavailable resources. Trusted project settings are ignored when the project is untrusted.

Supported settings shape:

```json
{
  "concurrency": 8,
  "backgroundWidget": true,
  "modelAliases": {
    "reviewer-model": "anthropic/claude-fable-5:high"
  },
  "skills": ["*", "!experimental-*"],
  "extensions": ["**/*", "!**/unsafe.mjs"],
  "extensionSettings": { "herdr": { "enableFullyInspectableMode": true }, "trajectory": { "port": 7432 } },
  "tools": ["*", "!write"],
  "retention": { "olderThanDays": 30, "maxTerminalRuns": 200 }
}
```
The supported resource fields are direct `skills`, `extensions`, and `tools` arrays. `skills` matches discovered skill names, `extensions` matches discovered normalized extension paths, and `tools` matches only the current root or parent tool boundary. Selectors never create unavailable resources. The legacy `disabledAgentResources` field is rejected; it is not an alias for these fields. `extensionSettings` is an arbitrary map of safe extension-owned JSON values; the core validates only its structure and built-in settings. A trusted project `extensionSettings` field replaces the complete global map, including `{}`. Roles retain inherited top-level keys they omit and replace each declared key in full; nested objects and arrays are never merged. A role `{}` inherits, while a declared empty value such as `{ "acme": {} }` replaces that top-level value. Registered extension validators receive the complete effective map plus source context. The obsolete `extensions.herdr` object is rejected.
The strict top-level settings keys are exactly `concurrency`, `backgroundWidget`, `modelAliases`, `skills`, `extensions`, `extensionSettings`, `tools`, and `retention`. `backgroundWidget` is accepted only in the global file, and project settings may use the other keys. `retention` accepts positive integer `olderThanDays` and `maxTerminalRuns` limits. It is applied best-effort at session start to hard-terminal runs only (`completed`, `failed`, `stopped`); dependency and worktree safety rules can retain additional runs.

### Trajectory

`extensionSettings.trajectory.port` is the local Trajectory HTTP server port and must be a positive integer when configured. If Trajectory settings are absent, the server defaults to `7432`. A valid `PI_WORKFLOW_TRAJECTORY_PORT` environment variable overrides the configured port. The browser UI follows the system light or dark preference; a toggle in the sidebar overrides it per browser. Trajectory auto-attaches by default without opening a browser when a session restores persisted workflow runs or after its first successful workflow launch, once per interactive Pi session. `/workflow trajectory` remains the manual re-open and starts or attaches to the local Trajectory server and opens its browser UI. Stale Trajectory servers are replaced when the server or UI files change. Workflow-agent sessions persist one `pi-workflows:tool-timing` JSONL entry per completed tool with start, completion, duration, and error status; a tool that crashes before completion has no duration record. Trajectory loads up to 400 non-timing transcript entries per agent and retains their matching timing records.
Trajectory also publishes current-session durable standalone subagents as first-class entities, not fabricated workflow runs. In the browser sidebar they appear in a sibling `SUBAGENTS` section for each publisher; the home view has one Gantt lane per subagent with tool timings, and selecting one opens its transcript, model, tools, accounting, result or failure, and worktree view. Use Agent details to inspect Prompt, Tools, Skills, Extensions, Environment, and Output without selecting a system-prompt event. Running subagents expose Stop and Steer, while failed or stopped subagents expose Retry; retry creates a new subagent ID and follows it in the UI. Pause, resume, and checkpoint controls do not apply to subagents.

### Concurrency

`concurrency` is an integer from `1` through `16`. The default is `8`. Agents queue in the order the workflow calls `agent(...)`: when a script issues several calls concurrently (for example inside `parallel(...)`), the limit admits them in call order rather than in the order their replay lookups happen to finish.

### Background workflow widget

`backgroundWidget` is a global boolean that defaults to `true`. Set it to `false` to disable the live background-run tree and durable background-run transcript receipts. Foreground workflow rendering is unchanged. Headless and non-TUI hosts do not draw the widget or append receipts.

### Models and aliases

A model reference is static when it is a literal concrete `provider/model[:thinking]` value or a literal alias. Concrete model resolution occurs after generic preparation; core shape validation still rejects invalid thinking suffixes.

`modelAliases` is a case-sensitive object. Names must match `[A-Za-z][A-Za-z0-9_-]*`. Values are concrete `provider/model` references or another alias, optionally with a thinking suffix such as `:high`. Unknown targets and cycles fail before execution. An alias-specific suffix overrides the target suffix; a suffix on the call's model reference has higher precedence. Separate `thinking` options are rejected.

Static settings aliases override dynamic aliases with the same name. Use settings for fixed policy and an extension `modelAliases` entry when the target must be resolved from the live model inventory.

#### Dynamic model selection

A model is dynamic when its value cannot be determined during preflight, for example when an agent option is computed from runtime data, `args`, a spread, or another non-literal expression. The workflow is still launchable; the model is resolved when that agent starts against the run's captured model and alias inventory. The resolved model must be available or the agent fails with `UNKNOWN_MODEL`. Dynamic model values are not a new model-registration mechanism; use a static alias or an extension resolver when the policy itself must be named and reusable.

Dynamic model aliases are resolved once per launch or resume, then captured for that execution segment. They are not re-resolved on every agent turn. Already prepared identities retain their concrete model on retry/resume; new identities use the current resolved alias map.

### Resource selectors

The direct `skills`, `extensions`, and `tools` fields use ordered Minimatch selectors. Rules are applied global and trusted project defaults, then agent-call options and generic preparation. Every discovered candidate starts enabled; a matching positive pattern enables it, `!pattern` disables it, and the last matching rule wins. `!*` clears the current selection before narrower positive patterns are applied. An empty selector array contributes no matches as a selector layer. Use `!*` before positive patterns when a call must restrict the candidate set, or use `!*` alone to select none. Selectors never create unavailable resources or bypass trust filtering. Child tools, skills, and extensions cannot exceed the parent boundary. Doctor reports `AGENT_RESOURCE_TOOL_SELECTOR_ALLOWLIST` when a positive-only tool selector looks like an ineffective allow-list.

Extension selector normalization is context-specific. In settings, `~` and `~/...` expand from the home directory, `file://` URLs become filesystem paths, and relative paths resolve from the directory containing that settings file. In role frontmatter, the same forms are supported and relative paths resolve from the role file's directory. Existing non-magic paths and the static prefixes of magic paths in settings and role files are canonicalized with `realpath` when possible; `*`, `**`, and `**/...` remain cwd-independent patterns. At call level, those three forms also remain cwd-independent. Other relative selectors resolve from the agent launch cwd: non-magic selectors are canonicalized, while magic patterns are path-resolved without `realpath`. Call-level `~` and `file://` values are not expanded by the runtime.

## `piewf doctor --json`

When doctor completes its checks, `piewf doctor --json` writes one JSON object. A command-level failure writes an error to stderr, exits `1`, and produces no JSON. The current top-level `DoctorReport` keys are `cwd`, `agentDir`, `settingsPath`, `settings`, `settingsSources`, `trust`, `activeTools`, `piExtensions`, `piSkills`, `functions`, `modelAliases`, `resourcePolicy`, optional `agentInspection`, and `diagnostics`. Diagnostics have `severity`, `code`, `message`, and optional `source` and `hint`. Resource policies expose global/project selectors, effective selected resources, unmatched patterns, and `selectorSources`; agent inspection adds the prepared selector layers plus model, tools, prompt, final system prompt, setup hooks, and setup diagnostics. Model-alias entries carry `name`, `kind`, `provenance`, and dynamic-alias `version` and `headline`.

Treat `code` and named fields as the machine contract, tolerate omitted optional fields, and ignore unknown fields for forward compatibility. There is no schema-version field; do not parse the human-readable doctor report. For a completed report, the exit status is `0` unless a diagnostic has severity `error`, in which case it is `1`. `settingsSources` gives source paths for represented effective settings. `resourcePolicy.globalSettingsPath` and `projectSettingsPath` identify selector files, and top-level `resourcePolicy.selectorSources` carries only the global and project layers; prepared layers appear under `agentInspection.resources.selectorSources`.

## Standalone Subagents

The core package's built-in subagent tools launch one independent agent session per task. Single-shot means one agent run rather than a workflow graph; the agent may use tools, take multiple turns, and accept steering.

The model-facing surface is exactly:

| Tool | Contract |
| --- | --- |
| `subagents_run` | Start one run. `prompt` is required; `mode` defaults to `background` and may be `foreground`. |
| `subagents_inspect` | Omit `id` for current-session summaries (`scope: "all"` for every session) or provide it for detailed progress and terminal output. |
| `subagents_steer` | Send one message to a running ID. |
| `subagents_stop` | Stop one run and clean its worktree. |
| `subagents_retry` | Start a fresh run from a failed or stopped request, with a new ID and the original mode. |

`subagents_run` accepts the same `label`, `model`, `skills`, `extensions`, `tools`, `contextFiles`, `role`, `worktree`, `outputSchema`, `retries`, and `timeoutMs` options as workflow agents. `role` is an optional extension-owned JSON option. Concrete models are `provider/model:thinking`. The `worktree` option requires a clean working tree at worktree creation or the run fails with `WORKTREE_FAILED`.

Background calls return an ID immediately. Foreground calls return a terminal envelope and do not produce a background completion follow-up. Do not poll a running ID; call `subagents_inspect({ id })` only when current state or output is needed. Cross-session retry starts fresh and does not restore the old native conversation.
## Herdr integration

`@piewf/herdr` requires the core workflow extension and a Herdr-managed pane. It registers workflow attempt actions and a transport setup hook, not model-facing tools.

- The live action hands a transferable running session to Herdr and later returns ownership to the local SDK.
- The completed action opens a persisted completed, failed, or cancelled attempt for inspection.
- `extensionSettings.herdr.enableFullyInspectableMode: true` launches every workflow agent in a dedicated Herdr workspace and hides manual live handoff.
- `PI_CODING_AGENT_DIR` controls where Herdr reads workflow settings.

See the [Herdr guide](herdr.html) for handoff ownership, interruption behavior, and limitations.

## Create an extension

Use TypeScript or JavaScript as a normal Pi extension. The package import is `pi-extensible-workflows`.

Rules:

- Export a default factory.
- Call `registerWorkflowExtension()` inside the factory, not at module top level.
- Provide a strict semantic `version` and non-empty `headline`.
- Register at least one capability: `functions`, `modelAliases`, `validateSettings`, `agentSetupHooks`, or `agentAttemptActions`. Function descriptions remain on each registered function and power catalog discovery and CLI help.
- Treat all extension code as trusted host code.
- Use globally unique, stable names. Registration is frozen after `session_start`; late registration fails with `REGISTRY_FROZEN`.
- Do not use the removed `workflows` or `variables` registration formats.

Minimal extension with a reusable function:

```ts
import { Type } from "typebox";
import { defineWorkflowFunction, registerWorkflowExtension } from "pi-extensible-workflows";

const greet = defineWorkflowFunction({
  description: "Return a greeting for one person.",
  run(input) {
    return `Hello, ${input.name}!`;
  }
  input: Type.Object(
    { name: Type.String() },
    { additionalProperties: false }
  ),
  output: Type.String(),
});

export default function extension() {
  registerWorkflowExtension({
    version: "1.0.0",
    headline: "Greeting helpers",
    functions: { greet }
  });
}
```

### Extension registration fields

| Field | Required contract |
| --- | --- |
| `version` | Semantic version string such as `1.0.0`. |
| `headline` | Non-empty short label. |
| `functions` | Named host functions with JSON schemas and `run(input, context)`. |
| `modelAliases` | Named dynamic resolvers with `resolve(context)`. |
| `agentSetupHooks` | Named trusted setup hooks with optional finite `priority`. |
| `agentAttemptActions` | Named `/workflow` actions, optionally shared with `/subagents` through paired `visibleStandalone(context)` and `runStandalone(context)`, alongside `label`, synchronous `visible(context)`, and `run(context)`. |

Unknown top-level extension keys are rejected. Function names must be identifier-shaped, globally unique, and must not be reserved globals such as `agent`, `args`, `JSON`, `extensions`, or `workflow_catalog`. Model alias names must match `[A-Za-z][A-Za-z0-9_-]*`. Hook and action names must be identifier-shaped and globally unique.

### Registered functions

A function has exactly `description`, `input`, `output`, and `run`. Schemas must be JSON-compatible; the input schema must describe one object. Inputs and outputs are validated and cloned at the runtime boundary. `run` may return a JSON value or a promise.

For TypeScript extensions, prefer TypeBox schemas with `defineWorkflowFunction()`, as in the example above. The helper infers the read-only `run` input type from `input` and checks its synchronous or asynchronous return type against `output`. Hand-written JSON Schema remains supported but does not provide this inference.

The `run` callback also receives a read-only host context for functions that explicitly need orchestration. Keep workflow composition and workflow-specific rules in the bundled skill rather than copying them into an extension guide.

Completed function calls are journaled and can replay without running the implementation again. Design external effects to be idempotent or bounded. A host crash after an external effect and before journaling can repeat that effect.

### Dynamic model aliases

Register a resolver like this:

```ts
modelAliases: {
  reviewer: {
    resolve({ availableModels, rootModel }) {
      const preferred = "anthropic/opus";
      if (availableModels.has(preferred)) return `${preferred}:high`;
      return `${rootModel.provider}/${rootModel.model}`;
    }
  }
}
```

The resolver context has `cwd`, `projectTrusted`, `rootModel`, `knownModels`, `availableModels`, and an `AbortSignal`. Resolve once per launch or resume. Return a non-empty normal model reference or another alias. Invalid results, cycles, unavailable targets, thrown errors, and cancellation fail the launch with a diagnostic naming the alias and extension.

### Agent setup hooks

Hooks run after generic preparation and concrete model/tool/cwd resolution but before the agent session is created. They run in ascending `priority` order; equal priorities use the hook name. The default priority is `10`.

Use a custom JSON-compatible agent option as an explicit opt-in instead of changing every agent:

```ts
agentSetupHooks: {
  advisor: {
    setup(agent, context) {
      if (context.signal.aborted || agent.options.advisor !== true) return;
      const note = "\n\nAdvisor: call out one concrete risk and one next check.";
      agent.sessionInput.systemPromptAppend =
        (agent.sessionInput.systemPromptAppend ?? "") + note;
    }
  }
}
```

Hooks may mutate the prompt, options, session input, or transport, but the immutable prepared launch remains the capability ceiling. Resource-policy mutation is narrowing-only: adding a selector that widens skills, extensions, or tools fails setup with `INVALID_METADATA`; negated narrowing is accepted. Final resource selector order is global settings, trusted project settings, generic preparation, call-level selectors, then hook-added narrowing. The runtime preserves hook negations in their original order, including negations interleaved with positive selectors, while applying them as the final overlay. Keep hooks short and cancellation-aware. Hook failures prevent session creation and are not native-session retries. Each agent retry starts from a fresh setup baseline and runs hooks again.

### Generic agent preparation

Use `agentPreparationHooks` for plugin-owned policy before concrete model resolution:

```ts
agentPreparationHooks: {
  advisor: {
    optionsSchema: { type: "object", properties: { advisor: { type: "boolean" } }, additionalProperties: true },
    prepare(configuration, context) {
      if (context.options.advisor === true) configuration.systemPromptAppend += "\nCall out one risk.";
    }
  }
}
```

All loaded schemas validate original options before any hook runs. Hooks run by ascending priority then name. The immutable context supplies options, effective cwd, agentDir, trust, root defaults, authorized tools/skills/extensions, known/available models, signal, and execution/inspection mode. Preparation can set model text, selectors, context scopes, settings, and prompts. An absent `systemPrompt` retains native Pi behavior; `systemPromptAppend` adds policy instructions without replacing it.

Workflow calls, handles, nested agents, standalone subagents, and CLI inspection use the same preparation flow. Core persists the concrete prepared configuration by operation/handle identity before session creation. Resume and retry reuse it without rerunning plugin resolution, then revalidate current trust and availability. Removed capabilities fail with `RESUME_INCOMPATIBLE`; historical snapshots are rejected. Frozen values include the model, plugin instructions, selectors, context scopes, and settings, not extension code, skill/AGENTS/SYSTEM/APPEND bytes, or external state. Resources are reread under current trust and ceilings; external effects are not guaranteed exactly once.

### Optional roles

Core forwards `role` as opaque JSON without interpretation. The independent `@piewf/pi-ext-roles` Pi extension owns its schema, discovery, settings, precedence, and composition through a generic preparation hook. See its own guide for role authoring. There is no core `/roles` export, role catalog, role-specific doctor flag, or role-file tooling.

Inspect a plugin option with `piewf doctor --agent-options '{"role":"reviewer"}' --prompt "Review this"`. This uses the shared preparation/setup path without persistence or provider contact.

## Verification checklist

When creating or changing an extension or role:

1. Start from the copyable extension template.
2. Keep registration inside the default extension factory.
3. Use strict JSON schemas and JSON-compatible values.
4. Check names for global collisions and reserved names.
5. Keep trusted hooks opt-in, short, and cancellation-aware.
6. Test registration, role discovery, schema validation, replay-sensitive behavior, and invalid configuration.
7. Run `npm run check` from the repository root.

The workflow DSL, workflow invocation examples, checkpoint handling, budgets, worktrees, and recovery are intentionally outside this file. Read the bundled workflow skill for those tasks.

### Native role CLI versus programmatic consumers

`pi-role` composes static roles/settings and spawns native `pi` from PATH without an upfront SDK session or extension factories. Metadata selectors remove selected-out factories before spawn; dynamic contributor discovery is not a CLI feature. Role/shared tool selectors restrict the model-declared loadout, not deferred/codemode capabilities. Native `--tools` overrides the loadout inside its registry allowlist; `--exclude`, `--no-tools` and `--no-builtin-tools` are hard ceilings across reload and later turns.

The binary ignores shared/per-role `extensionSettings`. Partial `contextFiles` scopes fail explicitly unless native `--no-context-files` suppresses context; only all scopes or `[]` are expressible. Explicit models, help and session handling are native, without catalog validation or role-model fallback. Independent `discoverRoles`, `resolveRole` and `composeRoleConfiguration` return definitions/configuration/resolved options, not SDK sessions or a special settings event channel. Workflow agents and subagents apply those options and own provider loading, partial contexts, recovery snapshots and disposal. Workflow transports `extensionSettings` itself via its existing consumer session/start/hook seam (`session_start` `event.settings`). See [roles](roles.html#pi-role).
