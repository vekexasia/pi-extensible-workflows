# @piewf/cli

Terminal commands for [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows): `pi-role` starts Pi as a role, `piewf` operates workflows.

Requires Node.js 22.19 or newer and the `pi` command on `PATH`. This is trusted host code with the same filesystem and process access as Pi.

```sh
npm install -g @piewf/cli
```

## pi-role

Start a regular Pi session with a role's model, tools, skills, extensions, and system prompt. Everything after the role name goes to Pi unchanged.

```sh
pi-role                                    # list the available roles
pi-role reviewer                           # interactive Pi as the reviewer role
pi-role scout -p "Where is the retry logic?"   # one-shot prompt
pi-role developer --continue               # resume the last session as the developer role
pi-role reviewer --approve                 # trust the project so its roles and settings apply
npx -p @piewf/cli pi-role oracle           # without installing
```

Roles come from the bundled starter roles, `~/.pi/agent/pi-extensible-workflows/roles/*.md`, and, in trusted projects, `.pi/pi-extensible-workflows/roles/*.md`. The [roles guide](https://vekexasia.github.io/pi-extensible-workflows/roles.html#pi-role) lists what each role field becomes on the Pi command line and the launcher's limits; the [role file reference](https://vekexasia.github.io/pi-extensible-workflows/roles.html#files) covers writing your own.

## piewf

```sh
piewf doctor [role|role-file] [--role <role>] [--prompt <text>] [--json]
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
