# nix-dev-exec

MCP server that replaces free-form `Bash` with a project-owned registry of
named operations, each executed as `nix develop -c <expanded argv>`. The agent
never sees a shell string — it picks an operation by name, supplies validated
args, and receives structured output.

## Status

Packaged. Runnable standalone via Nix (`nix build`) or as part of the
[mcp-toolbelt](../../) collection.

## Why this exists

`Bash` is the highest-blast-radius tool in an agent's toolbox. Even with
`Bash` permission prompts on, an autonomous agent can:

- Run a command in the wrong shell environment (no `nix develop`)
- Use a binary that isn't in the project's pinned toolchain
- Chain commands with `&&` / `|` to bypass per-command policy
- Read sensitive files via `cat` to dodge `fs-fallback`'s deny list

Replacing `Bash` with a registry of named, parameterized operations fixes all
four. The agent calls `run(name="test", args={...})` and the server expands
that to a single `nix develop -c <argv>` invocation with no shell
metacharacter exposure.

## MCP tools

| Tool                        | Purpose                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `list_operations()`         | List every registered operation with description. Start here.                                              |
| `describe_operation(name)`  | Full schema for one operation: template, args, types, validation, timeout, cwd, sandbox summary.           |
| `describe_sandbox(name)`    | Full bwrap argv that will prefix this op — audit-grade view of the sandbox.                                |
| `dry_run(name, args?)`      | Return the expanded argv (including bwrap prefix) without executing.                                       |
| `run(name, args?)`          | Execute the operation. Returns `{stdout, stderr, exit_code, signal, duration_ms, expanded_command, sandbox, ...}`. |
| `env_info()`                | `nix develop -c env`, key binary paths, and dev-shell store path. Cached 5 minutes.                        |
| `which(binary)`             | `nix develop -c command -v <binary>`. Cached 5 minutes. Binary name validated.                             |
| `recent_runs(n?)`           | Last N executions (default 20) with timing, exit codes, byte counts. In-memory ring buffer.                |

## Sandbox

Every operation runs inside a [`bubblewrap`](https://github.com/containers/bubblewrap)
(`bwrap`) sandbox by default. The server refuses to start if `bwrap` isn't on
`PATH` — there is **no silent fallback** to unsandboxed execution. Actual
launch shape is:

```
bwrap <sandbox-argv> -- nix develop -c <expanded-op-argv>
```

Three built-in presets, picked per op with `sandbox.preset`:

| Preset      | Network | RW binds                                              | RO binds                                                  | Use for                                    |
| ----------- | ------- | ----------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| `dev`       | on      | project root + `~/.cache`, `~/.local/share`, `~/.npm`, `~/.cargo/{registry,git,bin}`, `~/.rustup`, `~/.pnpm-store` | `/nix`, `/etc`, `~/.npmrc`, `~/.yarnrc`, `~/.gitconfig`, `~/.git-credentials` | Normal dev commands (default preset).      |
| `strict`    | **off** | project root only. `$HOME` is a fresh tmpfs.          | `/nix`, `/etc`, `~/.gitconfig`                            | Lint, typecheck, offline tests.            |
| `install`   | on      | same as `dev` (package caches must persist).          | same as `dev`                                             | Package installs. Signals mutating intent. |

Every preset additionally:

- Mounts `/nix` and `/etc` read-only, `/proc`, a minimal `/dev`, and tmpfs `/tmp`.
- Puts the project root on a RW bind at its real absolute path.
- Puts `$HOME` on a tmpfs, then re-binds only the per-preset RW/RO paths above. **Everything else under `$HOME` (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg`, `~/Documents`, …) is invisible inside the sandbox.**
- Unshares user, IPC, PID, UTS, cgroup namespaces; sets `--die-with-parent` and `--new-session`.

Missing bind sources (e.g. no `~/.git-credentials`) are handled silently via
`--bind-try` / `--ro-bind-try`.

### Per-op tweaks

```toml
[sandbox]
default_preset = "dev"
extra_rw = []
extra_ro = []

[operations.test]
command = "pnpm test"
sandbox.preset = "strict"

[operations.custom]
command = "pnpm build"
sandbox.preset = "dev"
sandbox.extra_rw = ["~/.custom-tool-cache"]
sandbox.extra_ro = ["~/.company-ca"]
```

### Escape hatch: `sandbox = "off"`

For ops that legitimately require unsandboxed host access (e.g. a deploy
script that must read `~/.ssh`), set the scalar `sandbox = "off"` on that op.
The value must literally be the string `"off"` — booleans are rejected at load
so `grep '"off"'` finds every escape.

Effects:

- Loud stderr warning at every invocation.
- `sandbox: { mode: "off", warning: "..." }` in the tool response.
- No confinement whatsoever — the op runs with the server's PATH, HOME, and
  filesystem access. Reviewers should treat any `sandbox = "off"` in the
  registry as a policy exception.

The agent **cannot** disable the sandbox at call time; it can only pick from
what the registry allows. Adding `sandbox = "off"` requires a config change,
which lives in version control.

### Auditing what a run actually does

- `describe_sandbox(name)` returns the full bwrap argv verbatim.
- `dry_run(name, args)` returns `full_argv` prefixed with the bwrap command
  line so you can copy-paste it into a terminal for inspection.
- `run` responses include a `sandbox` field with the effective mode, preset,
  and network policy.

### Runtime requirements

- `bwrap` on `PATH`. The bundled Nix wrapper adds `pkgs.bubblewrap`
  automatically.
- Unprivileged user namespaces (`CLONE_NEWUSER`) enabled in the kernel. On
  Debian/Ubuntu: `sudo sysctl kernel.unprivileged_userns_clone=1`. On NixOS:
  `security.unprivilegedUsernsClone = true;`. If the kernel refuses, bwrap
  fails with a clear "setting up uid map: Permission denied" — the server
  surfaces this in the run's `stderr` with a remediation hint.

## Operation registry

Operations live in `.nix-dev-exec.toml` at the project root. The server walks
upward from `cwd` to find it (override with `NIX_DEV_EXEC_REGISTRY`).

```toml
[operations.test]
description = "Run the test suite. Use `filter` to narrow."
command     = "pnpm test {filter}"
args.filter = { type = "string", default = "", validate = "^[a-zA-Z0-9_./-]*$" }

[operations.test_one]
description = "Run a single test file."
command     = "pnpm test {file}"
args.file   = { type = "path", must_exist = true, must_match = "**/*.test.ts" }

[operations.lint]
description = "Lint the codebase."
command     = "pnpm lint"

[operations.flake_check]
description = "Validate the flake."
command     = "nix flake check --no-build"
timeout     = 600
```

Per-op keys:

| Key                | Type    | Default              | Notes                                                                    |
| ------------------ | ------- | -------------------- | ------------------------------------------------------------------------ |
| `description`      | string  | `""`                 | Free text shown to the agent.                                            |
| `command`          | string  | *required*           | Whitespace-split into an argv list. See safety rules below.              |
| `args.<name>`      | table   | `{}`                 | Type + validation for each `{name}` placeholder in the template.         |
| `interactive`      | bool    | `false`              | If true, `run` refuses the op with a helpful error.                      |
| `timeout`          | seconds | `300`                | Per-op wall clock. Use `timeout_ms` for millisecond precision.           |
| `max_output_bytes` | int     | `1048576` (1 MiB)    | Stdout/stderr each capped independently; truncation marker appended.     |
| `cwd`              | string  | project root         | Must resolve inside project root; escapes rejected at load time.         |

Arg schema:

| Field         | Applies to  | Meaning                                                              |
| ------------- | ----------- | -------------------------------------------------------------------- |
| `type`        | all         | `string`, `int`, `path`, or `enum`.                                  |
| `default`     | all         | Fallback when arg omitted or empty. Skip to require the arg.         |
| `validate`    | string/path | Regex the value must fully match.                                    |
| `must_exist`  | path        | Path must exist on disk (relative resolved against project root).    |
| `must_match`  | path        | Glob the value must match (`*` = non-slash, `**` = any).             |
| `values`      | enum        | Allowed literal values.                                              |

## Security model

Four layers:

1. **Registry.** Operation must exist in `.nix-dev-exec.toml`. No free-form
   commands.
2. **Load-time template safety.** Any command template containing shell
   metacharacters (`&&`, `||`, `;`, `|`, `>`, `<`, backtick, `$(`) is rejected
   at load with a loud error. Placeholders must occupy a full argv slot —
   `"echo pre-{name}"` is rejected; `"echo {name}"` is accepted.
3. **Argv-only substitution.** The template is split into argv **once**, at
   load. Each `{name}` slot is replaced 1:1 with the validated arg value.
   Execution is `spawn(bin, argv, {shell: false})` — the OS never sees a shell
   string, so quoting, metacharacters, and whitespace in arg values have zero
   shell effect.
4. **Bubblewrap sandbox.** Every op runs inside a `bwrap` sandbox by default.
   `$HOME` is a tmpfs with a per-preset RW/RO allowlist, so `~/.ssh`,
   `~/.aws`, `~/.gnupg`, `~/Documents`, etc. are invisible. Namespaces are
   unshared (user, IPC, PID, UTS, cgroup). Network is off for `strict`. See
   the [Sandbox](#sandbox) section for the full model.

Arg values are validated *before* substitution. Without a `validate` regex,
string/path args fall back to a deny list rejecting shell metacharacters and
whitespace. Enum args must literally match `values`; path args honor
`must_exist` and `must_match`.

Interactive ops are refused at `run` time:

> Operation '<name>' is marked interactive; MCP cannot handle interactive
> I/O. Run it manually or use the non-interactive variant.

## What is **not** exposed

- Free-form shell strings
- `&&` / `||` / `;` / `|` chaining
- Subshells, env-var sets, redirects, globs
- Anything not in `.nix-dev-exec.toml`

If the agent needs something missing, the path is: **edit the registry first,
then call the new operation**. Operations are project policy and live in
version control.

## Packaging (Nix)

Standalone:

```bash
cd servers/nix-dev-exec
nix build
./result/bin/nix-dev-exec --help
```

The Nix wrapper puts `nix develop` on PATH so the server works even when its
consumer's PATH is minimal.

Inside a Node dev shell:

```bash
cd servers/nix-dev-exec/server
npm install
npm run build
node dist/index.js --check ../.nix-dev-exec.toml.example
```

## MCP client wiring

```json
{
  "mcpServers": {
    "nix-dev-exec": {
      "command": "/path/to/nix-dev-exec/result/bin/nix-dev-exec"
    }
  }
}
```

The server discovers `.nix-dev-exec.toml` by walking up from the launching
process's `cwd`. Set `NIX_DEV_EXEC_REGISTRY=/abs/path/.nix-dev-exec.toml` to
skip discovery.

## Briefing pattern

Tool description on `run` (used by the agent):

> Execute a registered project operation via `nix develop -c <expanded argv>`.
> Returns structured stdout, stderr, exit_code, duration_ms, and the
> expanded_command actually invoked. This is your only shell. Call
> `list_operations()` first. Add new ops by editing `.nix-dev-exec.toml`.

## Composition

This server is the substrate every other command-running wrapper composes
over. Sits behind [`nix-mcp-proxy`](../nix-mcp-proxy/) for per-agent /
per-environment policy layering (e.g. "CI can call any op; local agent can't
call `deploy`").

## Open design questions

Answered by this implementation:

- **Env injection.** For now, ops strictly inherit `nix develop`'s
  environment. Per-op `env` tables can be added later without a schema break.
- **Caching of pure ops.** Not implemented; `nix develop` and downstream
  build tools handle their own caching.

Still open (not handled by this pass):

- **Long-running / background ops.** `pnpm dev` — right now the timeout
  kills it. Needs a separate `start_background_op` / `stop_run(id)` /
  `tail_run(id)` surface.
- **Streaming output.** MCP doesn't natively stream. Everything is buffered
  and returned on close. A tail-file variant would help long ops.
- **Multiple flakes.** Monorepos with per-package flakes — operation could
  specify `flake_ref = "./packages/api"`. Currently every op runs in
  `nix develop` rooted at the project root.
