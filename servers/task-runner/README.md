# task-runner

Nix packaging for [`devrelopers/shell-mcp`](https://github.com/devrelopers/shell-mcp)
(pinned to tag `v0.1.1`) — a Model Context Protocol server providing scoped,
allowlisted shell access for Claude Desktop and other MCP clients.

## Upstream research

| Field | Value |
|---|---|
| Crate | `shell-mcp` (installable via `cargo install shell-mcp`) |
| Latest release | **v0.1.1** (2026-04-30, commit `a37728613104199763a593f320440bd8110f62cf`) |
| Repository | [devrelopers/shell-mcp](https://github.com/devrelopers/shell-mcp) |
| License | MIT (Copyright 2026 DevRelopers.io) |
| Rust edition | 2021 |
| MSRV | 1.75 |
| Entry point | `shell-mcp` binary |
| Stdio mode | Uses `rmcp` transport-io — no special flags needed for MCP stdio |
| CLI flags | `--root <PATH>` (required) — sets the working directory scope. Also reads `SHELL_MCP_ROOT` env var. |

### Cargo dependencies

| Crate | Version | Features |
|---|---|---|
| rmcp | 1.5 | server, macros, transport-io, schemars |
| tokio | 1 | macros, rt-multi-thread, process, io-util, time |
| serde | 1 | derive |
| serde_json | 1 | — |
| toml | 0.8 | — |
| glob | 0.3 | — |
| shlex | 1.3 | — |
| anyhow | 1 | — |
| thiserror | 1 | — |
| clap | 4 | derive |
| dirs | 5 | — |
| tracing | 0.1 | — |
| tracing-subscriber | 0.3 | env-filter |
| schemars | 0.8 | — |

Dev dependencies: `tempfile 3`, `tokio 1` (macros, rt-multi-thread).

### How it works

The server exposes shell command execution over MCP stdio. Commands are
validated against per-directory `.shell-mcp.toml` allowlists before execution.
No shell invocation occurs — commands are spawned directly with discrete
arguments (via `shlex` parsing).

Configuration discovery walks up the directory tree (like `.gitignore`),
merging `~/.shell-mcp.toml`, repo-level, and workspace-level configs.
Innermost config takes precedence.

### Configuration (.shell-mcp.toml)

```toml
include_defaults = true  # include safe read-only commands (ls, git status, etc.)

allow = [
  "cargo build *",       # one additional argument
  "cargo test **",       # any number of arguments
  "npm run *",
]
```

Glob patterns in `allow`:
- `*` — matches exactly one additional argument
- `**` — matches any number of arguments (must be the final token)
- `?` — single-character wildcard

### Security model

- **`--root` is required** — the server refuses to start without a root
  directory, preventing accidental global access.
- Commands are NOT passed through a shell — no injection via `;`, `&&`, `|`, etc.
- The allowlist is checked before every execution; unmatched commands are rejected.
- Default allowlist includes safe read-only commands (ls, cat, git status, etc.)
  when `include_defaults = true`.

## Packaging notes

- Written in Rust — use `buildRustPackage` with `cargoHash`.
- Pin to tag `v0.1.1` (commit `a377286`). Use `fetchFromGitHub`.
- The `rmcp` crate uses `transport-io` feature for stdio MCP — no extra
  runtime dependencies beyond what Cargo resolves.
- Release profile enables thin LTO + single codegen unit + strip — the Nix
  build should respect or replicate this.
- Binary name is `shell-mcp` (matches `meta.mainProgram`).
- `--root` flag or `SHELL_MCP_ROOT` env var is required at runtime — the
  `claude-with-servers` wrapper should set this to the project directory.

## Standalone use

```nix
{
  inputs.task-runner.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/task-runner";

  outputs = { self, nixpkgs, flake-utils, task-runner }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in
      {
        devShells.default = pkgs.mkShell {
          packages = [ task-runner.packages.${system}.default ];
        };
      });
}
```

## Composition

The `task-runner` slot enables the agent to run build, test, lint, and format
commands within the project — scoped by the allowlist so only blessed commands
execute. Pairs with `git-guard` for version control operations.
