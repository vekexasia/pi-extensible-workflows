# @piewf/cli

Terminal commands for [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows): `piewf` operates workflows without a roles dependency.

Requires Node.js 22.19 or newer and the `pi` command on `PATH`. This is trusted host code with the same filesystem and process access as Pi.

```sh
npm install -g @piewf/cli
```

## Optional roles

`pi-role` belongs to the independent `@piewf/pi-ext-roles` package, not this CLI. Enable its Pi extension explicitly to interpret workflow `role` options; without it, those options are ignored. See the [roles guide](https://vekexasia.github.io/pi-extensible-workflows/roles.html).

## piewf

```sh
piewf doctor [--agent-options <json>] [--prompt <text>] [--json]
piewf doctor cleanup [--older-than-days <days>] [--yes]
piewf inspect [session-id] [--json|--summary] [--failed]
piewf transcript <session-file>
piewf run <workflow-name> [workflow arguments]
piewf run --script <workflow.js> [--name <workflow-name>] [--input <json>]
piewf export <workflow-name> [--name <command>] [--output <path>] [--force]
piewf bundle <workflow-name> [--name <command>] [--output <directory>] [--force]
```

See [CLI operations](https://vekexasia.github.io/pi-extensible-workflows/developers.html#operations).

## License

MIT
