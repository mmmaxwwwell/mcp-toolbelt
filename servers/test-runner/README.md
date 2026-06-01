# test-runner

Nix packaging for [`privsim/mcp-test-runner`](https://github.com/privsim/mcp-test-runner)
(pinned to commit `83c84ed053f5`) — a Model Context Protocol server that
executes tests across multiple frameworks and parses structured results.

## Upstream research

| Field | Value |
|---|---|
| npm package | `@modelcontextprotocol/server-test-runner` (not published to npm — use `fetchFromGitHub`) |
| Version | **0.2.0** (from `package.json`; no tags or releases on GitHub) |
| Repository | [privsim/mcp-test-runner](https://github.com/privsim/mcp-test-runner) |
| License | MIT (Copyright 2025 Test Runner MCP) |
| Language | TypeScript (ES2022 target, NodeNext modules) |
| Node version | 20.18.1 (from `.node-version`) |
| Build system | `tsc` → `build/index.js` |
| Entry point | `node build/index.js` (has `#!/usr/bin/env node` shebang) |
| Stdio mode | Uses `@modelcontextprotocol/sdk` `StdioServerTransport` — no special flags needed |
| MCP tools | `run_tests` (single tool) |
| Runtime deps | `@modelcontextprotocol/sdk ^1.1.0` (only production dependency) |

### npm dependencies

**Production:**

| Package | Version |
|---|---|
| @modelcontextprotocol/sdk | ^1.1.0 |

**Dev only** (not needed at runtime):

| Package | Version |
|---|---|
| @swc/core | ^1.3.96 |
| @swc/jest | ^0.2.29 |
| @types/jest | ^29.5.14 |
| @types/node | ^20.17.14 |
| jest | ^29.7.0 |
| ts-jest | ^29.1.1 |
| typescript | ^5.0.0 |

### How it works

The server exposes a single MCP tool `run_tests` that accepts:

- **command** — the test command to execute (e.g. `npm test`, `cargo test`)
- **workingDir** — directory to run tests in
- **framework** — one of: `bats`, `pytest`, `flutter`, `jest`, `go`, `rust`, `generic`
- **outputDir** — optional directory for result files
- **timeout** — execution timeout in ms (default: 300000 / 5 minutes)
- **env** — optional environment variables
- **securityOptions** — controls for `allowSudo`, `allowSu`, `allowShellExpansion`, `allowPipeToFile`

The server spawns a child process with the test command, captures stdout/stderr,
then parses the output using framework-specific parsers to produce structured
test results (pass/fail counts, individual test cases, error messages).

### Supported frameworks

| Framework | Parser |
|---|---|
| Bats | TAP output parsing |
| Pytest | Python test output parsing |
| Flutter | Dart test output parsing |
| Jest | JavaScript/TypeScript test parsing |
| Go | `go test` output parsing |
| Rust | `cargo test` output parsing |
| Generic | Fallback for any command |

### Security model

- Commands are validated against security rules when using the `generic` framework
- By default: `sudo`, `su`, shell expansion, and pipe-to-file are blocked
- Security options can be explicitly enabled per-call via `securityOptions`
- Framework-specific commands (pytest, cargo test, etc.) bypass generic security
  checks as they are considered safe

### Environment variables

| Variable | Purpose |
|---|---|
| `NODE_PATH` | Path to node_modules |
| `FLUTTER_ROOT` | Flutter installation directory (Flutter framework only) |
| `PUB_CACHE` | Pub package cache location (Flutter framework only) |
| `RUST_BACKTRACE` | Set to `1` automatically for Rust tests |

## Packaging notes

- Written in TypeScript — use `buildNpmPackage` with `fetchFromGitHub`.
- **Not published to npm** — must fetch from GitHub. The repo has `package-lock.json`.
- Pin to commit `83c84ed053f5` (latest on main, 2025-11-09). No tags or releases exist.
- No `bin` field in `package.json` — the entry point is `build/index.js` with a
  shebang. Will need `installPhase` to create a bin wrapper or symlink.
- Only one production dependency: `@modelcontextprotocol/sdk`.
- No native addons — pure TypeScript/JavaScript, simpler than tree-sitter-mcp.
- Build step is just `tsc` — output lands in `build/`.
- Binary name for `meta.mainProgram`: `mcp-test-runner`.

## Standalone use

```nix
{
  inputs.test-runner.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/test-runner";

  outputs = { self, nixpkgs, flake-utils, test-runner }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in
      {
        devShells.default = pkgs.mkShell {
          packages = [ test-runner.packages.${system}.default ];
        };
      });
}
```

## Composition

The `test-runner` slot enables the agent to execute tests across multiple
frameworks (Jest, Pytest, Go, Rust, Bats, Flutter) and receive structured
pass/fail results. Pairs with `task-runner` for general shell commands and
`edit-surface` for code modifications informed by test failures.
