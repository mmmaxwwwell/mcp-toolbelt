<!-- Sync Impact Report
  Version change: 0.0.0 → 1.0.0 (initial ratification)
  Added principles: I–VII
  Added sections: Nix Constraints, Quality Gates
  Templates requiring updates: ✅ plan-template.md (Constitution Check aligns) | ✅ spec-template.md (no changes needed) | ✅ tasks-template.md (no changes needed)
  Follow-up TODOs: none
-->

# mcp-toolbelt Constitution

## Core Principles

### I. Nix-First

Every dependency, build, and development environment MUST be expressed as a Nix flake. Each MCP server is an independent flake under `servers/<name>/` with its own `flake.lock`. The root flake composes them via path inputs. No global installs, no `curl | sh`, no `npm install -g`. If Nix can express it, Nix MUST express it.

### II. MCP Protocol Conformance

Every server MUST speak the Model Context Protocol over stdio transport. The contract: send `initialize` → get a valid `protocolVersion` response. Send `tools/list` → get a non-empty tool array. Servers that default to HTTP MUST be wrapped or configured for stdio. No server ships without passing the three-level test (build, initialize, tools/list).

### III. Composable Independence

Each server is a standalone flake that builds, tests, and runs independently. No server depends on another server at build time. Composition happens at runtime via `claude-with-servers`, which auto-detects available binaries on PATH and generates a merged `.mcp.json`. A consumer can pull a single server without the rest.

### IV. Security by Construction

Replace free-form capabilities with constrained surfaces. No arbitrary shell — only registered operations. No arbitrary file writes — only allowlisted paths. No arbitrary git — only scoped repos/branches. Policy is declarative (TOML configs, proxy rules) and enforced mechanically by the server or proxy, not by prompt instructions. The agent's blast radius is bounded by the tool surface it can reach.

### V. Token Efficiency

Every MCP tool MUST return fewer tokens than the built-in tool it replaces while providing equal or more useful information. Mechanisms: pre-digested content (AST outlines, Readability extraction), structured output (typed JSON, not raw stdout), caching (FTS5-indexed results), scoping (path restrictions reduce exploratory calls), and deduplication (skip re-reads within a session).

### VI. Test-First at Three Levels

Every server MUST pass three automated test levels before merging:
1. **Build test** — `nix build .#<package>` succeeds.
2. **MCP smoke test** — `initialize` over stdio returns a valid `protocolVersion`.
3. **Tool listing test** — `tools/list` returns at least one tool.

Integration tests verify `claude-with-servers` generates a valid `.mcp.json` with all available servers. Tests are shell scripts in `tests/` — no test framework dependency, just exit codes.

### VII. Simplicity

Start with the minimum viable packaging: fetch upstream source, pin to a release tag, build with the appropriate Nix builder, export the binary. Add complexity (custom wrappers, output parsers, policy layers) only when the RUNBOOK or DESIGN.md explicitly calls for it. One commit per server. No speculative features.

## Nix Constraints

- Pin every upstream to a tagged release + content hash — never `main`
- Use `pythonRelaxDeps` / equivalent when nixpkgs has newer transitive deps
- Set `doCheck = false` when upstream tests require network or sandbox-incompatible fixtures
- Every flake exports: `packages.default`, `packages.<name>`, `meta` with description/homepage/license/mainProgram
- The root flake's `devShells.default` includes all server binaries for dogfooding

## Quality Gates

- No server is added to the root flake until it passes all three test levels
- `claude-with-servers` merges with existing `.mcp.json` — never overwrites user-added servers
- Every server has a `README.md` documenting: what it does, upstream source, expected MCP tools, how to bump the version
- Environment variable toggles (`MCP_TOOLBELT_<NAME>=0`) disable individual servers — all default to enabled

## Governance

This constitution is the authority for architectural decisions in mcp-toolbelt. All code changes MUST comply. Amendments require: documented rationale, version bump (semver), and update to this file. When in doubt, refer to `DESIGN.md` for the full vision and `RUNBOOK.md` for the implementation pattern.

**Version**: 1.0.0 | **Ratified**: 2026-05-23 | **Last Amended**: 2026-05-23
