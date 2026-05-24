# nix-dev-exec (design only)

Mechanical wrapper that runs every shell-ish operation as
`nix develop -c "<allowlisted command>"`. The agent never sees `bash`,
`/bin/sh`, or `Bash` — it sees a small registry of named operations. Project
defines what's in the registry; agent picks from it.

## Status

Design only — no implementation yet.

## Why this exists

`Bash` is the highest-blast-radius tool in the agent's toolbox. Even with
`Bash` permission prompts on, an autonomous agent can:

- Run a command in the wrong shell environment (no `nix develop`)
- Use a binary that isn't in the project's pinned toolchain
- Chain commands with `&&` / `|` to bypass per-command policy
- Read sensitive files via `cat` to dodge `fs-fallback`'s deny list

Replacing `Bash` with a registry of named, parameterized operations fixes all
four. The agent calls `exec.run(name="test", args={...})` and the server
expands that to a single `nix develop -c <command>` invocation with no shell
metacharacter exposure.

## MCP tool surface (planned)

### Run

- `run(name, args?)` — execute a registered operation; returns structured
  stdout/stderr/exit, never raw shell output
- `list_operations()` — what's registered, with descriptions
- `describe_operation(name)` — full schema for one operation
- `dry_run(name, args?)` — show the expanded command without running it

### Environment

- `env_info()` — what's in `nix develop`'s PATH, tool versions, env vars
  the project sets
- `which(binary)` — resolved store path for a binary

### Audit

- `recent_runs(n?)` — last N executions with timing, exit codes, outputs

## Operation registry

Operations live in `.nix-dev-exec.toml` at the project root. Each entry
defines a name, the underlying command, and the schema of allowed args.

```toml
[operations.test]
description = "Run the test suite. Use `filter` to narrow."
command     = "pnpm test {filter}"
args.filter = { type = "string", default = "", validate = "^[a-zA-Z0-9_./-]*$" }

[operations.test_one]
description = "Run a single test file."
command     = "pnpm test -- {file}"
args.file   = { type = "path", must_exist = true, must_match = "**/*.test.ts" }

[operations.lint]
description = "Lint the codebase."
command     = "pnpm lint"

[operations.lint_fix]
description = "Lint with autofix."
command     = "pnpm lint -- --fix"

[operations.flake_check]
description = "Validate the flake."
command     = "nix flake check --no-build"

[operations.repl]
description = "Open a Python REPL in the dev shell."
command     = "python"
interactive = false  # MCP can't do interactive; refuses with helpful error
```

Each operation:
- Always runs inside `nix develop -c "<expanded command>"` — no escape
- `{name}` placeholders are filled from validated args; no shell injection
  because args go through argv, not a shell string
- Args have types (`string`, `int`, `path`, `enum`) and validation rules
- Marked `interactive = true` ops are refused with a clear error pointing
  the agent at the non-interactive variant or human

## What is **not** exposed

- Free-form shell strings
- `&&` / `||` / `;` / `|` chaining
- Subshells, env-var sets, redirects
- Anything not in `.nix-dev-exec.toml`

If the agent needs something missing, the path is: **edit the registry first
(via `fs-fallback`), then call the new operation**. This is intentional —
operations are project policy and live in version control.

## Security model

Three layers:

1. **Registry.** Operation must exist in `.nix-dev-exec.toml`.
2. **Arg validation.** Each arg goes through type + regex/path checks before
   substitution. Substitution is argv-level, not shell-string-level.
3. **Resource limits.** Per-operation timeout, max stdout/stderr size,
   working directory pin (project root by default).

The proxy in front ([`nix-mcp-proxy`](../nix-mcp-proxy/)) layers per-agent
or per-environment policy on top (e.g. "CI runs can call any op; local agent
can't call `deploy`").

## Briefing pattern

The `run` tool description:

> **Run a registered project operation.** This is the only shell you have.
> **When to use.** Tests, builds, linters, formatters, type checks.
> **Available operations:** call `list_operations()` first.
> **Adding new ops.** Edit `.nix-dev-exec.toml` via `fs-fallback`. Don't
> ask for arbitrary shell — there is no arbitrary shell.

`start_session` includes the operation registry summary so the agent knows
its shell vocabulary up front.

## Composition

This server is the substrate every other wrapper runs commands through:

- [`pnpm-wrapper`](../pnpm-wrapper/) calls `nix-dev-exec.run(name="pnpm_add", args={...})` internally
- [`edit-surface`](../edit-surface/) calls it for formatter invocations
- [`code-graph`](../code-graph/) calls it for incremental updates

Sits behind [`nix-mcp-proxy`](../nix-mcp-proxy/) for consistent policy
enforcement.

## Open design questions

- **Long-running ops.** `pnpm dev` runs forever — register as a background
  op with a separate `stop_run(id)`? Or refuse interactive/server commands
  entirely and direct the human to launch them?
- **Streaming output.** MCP doesn't natively stream — buffer to a temp file
  and expose via `tail_run(id)`?
- **Multiple flakes.** Monorepos with per-package flakes — operation can
  specify `flake_ref = "./packages/api"`?
- **Caching.** Some ops are pure (lint, typecheck on unchanged files).
  Cache results keyed by content hash?
- **Env injection.** Should the project be able to set per-op env vars in
  `.nix-dev-exec.toml`, or strictly inherit from `nix develop`?
