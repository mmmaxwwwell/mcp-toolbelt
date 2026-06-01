# Feature Specification: Package Upstream MCP Servers

**Created**: 2026-05-23
**Status**: Draft
**Preset**: local

## User Scenarios & Testing

### User Story 1 - Package and use a single MCP server (Priority: P1)

A developer adds `mcp-toolbelt` as a flake input to their project. They pull a single server package (e.g., `mcp-server-git`) into their devShell. They enter the shell, run `claude-with-servers`, and the server appears in the generated `.mcp.json`. Claude Code can now call the server's MCP tools.

**Why this priority**: This is the core value proposition — one `nix build` gives you a working MCP server binary. Everything else builds on this.

**Independent Test**: `nix build .#<server>` succeeds, binary passes MCP initialize + tools/list smoke test.

---

### User Story 2 - Use all servers together via claude-with-servers (Priority: P2)

A developer has multiple server packages on PATH. They run `claude-with-servers` and all available servers are auto-detected, configured in `.mcp.json`, and launched. Claude Code gets all tools from all servers in a single session.

**Why this priority**: Composition is the toolbelt's differentiator — individual servers are useful, but the combined surface is the product.

**Independent Test**: `claude-with-servers` generates a valid `.mcp.json` containing entries for every server binary found on PATH.

---

### User Story 3 - Selectively disable servers (Priority: P3)

A developer wants to skip a specific server (e.g., the web browser). They set `MCP_TOOLBELT_WEB_BROWSER=0` before running `claude-with-servers`. The disabled server does not appear in `.mcp.json`.

**Why this priority**: Fine-grained control prevents unwanted tool exposure and reduces resource usage.

**Independent Test**: Set env var to 0, run `claude-with-servers`, verify server is absent from `.mcp.json`.

---

### User Story 4 - Consume a single server as a standalone flake (Priority: P3)

A developer doesn't want the full toolbelt. They point their flake input directly at `github:mmmaxwwwell/mcp-toolbelt?dir=servers/<name>` and get just that server's package.

**Why this priority**: Composable independence — each server flake must work standalone.

**Independent Test**: `nix build "github:mmmaxwwwell/mcp-toolbelt?dir=servers/<name>"` succeeds and binary runs.

---

### Edge Cases

- What happens when an upstream server needs runtime resources not available in the Nix sandbox (e.g., Playwright needs Chromium)?
  - Package Chromium via `pkgs.playwright-driver.browsers`, set `PLAYWRIGHT_BROWSERS_PATH` in a wrapper script.
- What happens when upstream pins a dependency version that conflicts with nixpkgs?
  - Use `pythonRelaxDeps`, npm `--legacy-peer-deps`, or Nix overlays to resolve. Document in the server's README.
- What happens when an upstream release has no tagged version?
  - Pin to a specific commit hash with content hash. Document the commit in the server's README.
- What happens when a server defaults to HTTP transport instead of stdio?
  - Wrap the binary or pass CLI flags (`--stdio`, `--transport stdio`, `serve`) to force stdio mode. Document in README.

## Requirements

### Functional Requirements

**Per-server packaging (repeat for each of the 7 servers):**

- **FR-001**: System MUST build each upstream server from source using `nix build` with no network access at build time (pure Nix build).
- **FR-002**: Each server flake MUST pin to a specific upstream release tag (or commit) + content hash.
- **FR-003**: Each server flake MUST export `packages.default` and `packages.<name>` with the server binary.
- **FR-004**: Each server flake MUST include `meta` with description, homepage, license, and mainProgram.
- **FR-005**: Each server binary MUST respond to MCP `initialize` with a valid `protocolVersion` over stdio.
- **FR-006**: Each server binary MUST respond to MCP `tools/list` with at least one tool.
- **FR-007**: Each server MUST have a `README.md` documenting: upstream source, version pinned, expected MCP tools, how to bump.

**Root flake composition:**

- **FR-008**: Root `flake.nix` MUST import each server as a path input with `nixpkgs` and `flake-utils` follows.
- **FR-009**: Root flake MUST re-export each server's package under `packages.${system}.<name>`.
- **FR-010**: Root flake's `devShells.default` MUST include all server binaries.

**claude-with-servers integration:**

- **FR-011**: `claude-with-servers` MUST auto-detect each server binary via `command -v`.
- **FR-012**: `claude-with-servers` MUST generate correct `.mcp.json` entries with the right command and args for each server.
- **FR-013**: Each server MUST be individually disableable via `MCP_TOOLBELT_<NAME>=0` environment variable.

**Testing:**

- **FR-014**: Each server MUST have a test script at `tests/<name>.sh` that runs all three test levels (build, initialize, tools/list).
- **FR-015**: Test scripts MUST use structured output: print `=== <test name> ===` headers, exit 0 on success, exit 1 on any failure.

### Servers to Package

| # | Server name | Upstream | Language | Builder |
|---|-------------|----------|----------|---------|
| 1 | `git-guard` | [mcp-server-git](https://pypi.org/project/mcp-server-git/) | Python | `buildPythonApplication` |
| 2 | `codebase` | [tree-sitter-mcp](https://github.com/nendotools/tree-sitter-mcp) | TypeScript | `buildNpmPackage` |
| 3 | `web-browser` | [fetcher-mcp](https://github.com/jae-jae/fetcher-mcp) | TypeScript | `buildNpmPackage` + Playwright |
| 4 | `task-runner` | [shell-mcp](https://github.com/devrelopers/shell-mcp) | Rust | `buildRustPackage` |
| 5 | `test-runner` | [mcp-test-runner](https://github.com/privsim/mcp-test-runner) | TBD | TBD — research needed |
| 6 | `edit-surface` | [mcp-contextual-code-edit](https://github.com/metaphorics/mcp-contexual-code-edit) | TBD | TBD — research needed |
| 7 | `sqlite-store` | [sqlite-memory-mcp](https://github.com/RMANOV/sqlite-memory-mcp) | TBD | TBD — research needed |

### Key Entities

- **Server flake**: Independent Nix flake under `servers/<name>/` with `flake.nix`, `flake.lock`, `README.md`.
- **Root flake**: Composition layer at `flake.nix` that imports all server flakes.
- **claude-with-servers**: Shell script that auto-detects servers and generates `.mcp.json`.
- **Test script**: Shell script at `tests/<name>.sh` that validates a single server.

## Non-Goals

- **No custom server implementation** — only packaging upstream projects into Nix flakes. Custom servers (edit-surface graph-routed ops, fs-fallback ACL layer, pnpm-wrapper fixed-verb surface, nix-dev-exec operation registry) are out of scope.
- **No macOS/Darwin support** — Linux only. `eachDefaultSystem` may be narrowed to `x86_64-linux` and `aarch64-linux`.
- **No HTTP/SSE transport** — stdio only, per MCP convention for Claude Code.
- **No Docker alternative** — Nix is the only packaging mechanism.
- **No nix-mcp-proxy integration** — the proxy is upstream and not yet buildable. Keep the existing placeholder slot; don't block on it.
- **No output parsing or policy layers** — just package the upstream binary as-is. Policy wrappers are future work.

## Success Criteria

- **SC-001**: All 7 server flakes build successfully with `nix build` [validates FR-001, FR-002, FR-003, FR-004]
- **SC-002**: All 7 servers pass MCP initialize + tools/list smoke tests [validates FR-005, FR-006]
- **SC-003**: Root flake builds and all server packages are accessible [validates FR-008, FR-009, FR-010]
- **SC-004**: `claude-with-servers` generates valid `.mcp.json` with all 7 servers when all binaries are on PATH [validates FR-011, FR-012]
- **SC-005**: Each server can be disabled via env var [validates FR-013]
- **SC-006**: All test scripts in `tests/` pass [validates FR-014, FR-015]
- **SC-007**: Each server has a complete README.md [validates FR-007]

## Assumptions

- All upstream servers have a tagged release or a stable commit to pin to
- All upstream servers support stdio MCP transport (possibly with CLI flags)
- Nix is available on the build/dev machine (Linux)
- Upstream licenses are MIT or similarly permissive
- `fetcher-mcp` (web-browser) will require special handling for Playwright/Chromium — this is expected to be the hardest server

## Enterprise Infrastructure (local preset)

- **Logging**: N/A — packaging project, no application code
- **Error handling**: N/A — upstream servers handle their own errors
- **Config**: Per-server `.mcp.json` entries generated by `claude-with-servers`
- **CI/CD**: GitHub Actions — `nix build` all servers + run all `tests/*.sh` on push. Single workflow.
- **Branching**: Direct-to-main — solo developer workflow
- **DX tooling**: `nix develop` gives you everything. `claude-with-servers` is the primary entry point.
- **Graceful shutdown**: Handled by `claude-with-servers` trap/cleanup (already implemented)
- **Health checks**: N/A — servers are stdio processes, not daemons
- **Security scanning**: Tier 1 only — Gitleaks pre-commit hook for secrets. No application-level scanning.
