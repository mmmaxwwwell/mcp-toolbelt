# Implementation Plan: Package Upstream MCP Servers

**Date**: 2026-05-23 | **Spec**: `specs/001-package-upstream-servers/spec.md`

## Summary

Package 7 upstream MCP servers into independent Nix flakes, wire them into the root flake and `claude-with-servers` launcher, and add 3-level test scripts. Each server follows the pattern established by `servers/code-graph/`.

## Technical Context

**Language/Version**: Nix (flake expressions), Bash (test scripts, launcher)
**Primary Dependencies**: nixpkgs (unstable), flake-utils
**Storage**: N/A
**Testing**: Shell scripts with `set -euo pipefail`, exit codes
**Target Platform**: x86_64-linux, aarch64-linux
**Project Type**: Library (Nix flake collection)
**Constraints**: Pure Nix builds (no network at build time), stdio MCP transport only

## Constitution Check

| Principle | Status |
|-----------|--------|
| I. Nix-First | PASS — everything is Nix flakes |
| II. MCP Protocol Conformance | PASS — 3-level test enforces initialize + tools/list |
| III. Composable Independence | PASS — each server is a standalone flake |
| IV. Security by Construction | N/A — packaging only, no policy layer in scope |
| V. Token Efficiency | N/A — packaging only, no output processing in scope |
| VI. Test-First at Three Levels | PASS — test scripts required per server |
| VII. Simplicity | PASS — minimum viable packaging, one commit per server |

## Project Structure

```
servers/
├── code-graph/          # EXISTING — working (v2.3.2)
│   ├── flake.nix
│   ├── flake.lock
│   └── README.md
├── git-guard/           # NEW — mcp-server-git
│   ├── flake.nix
│   ├── flake.lock
│   └── README.md
├── codebase/            # NEW — tree-sitter-mcp
│   ├── flake.nix
│   ├── flake.lock
│   └── README.md
├── web-browser/         # NEW — fetcher-mcp
│   ├── flake.nix
│   ├── flake.lock
│   └── README.md
├── task-runner/         # NEW — shell-mcp
│   ├── flake.nix
│   ├── flake.lock
│   └── README.md
├── test-runner/         # NEW — mcp-test-runner
│   ├── flake.nix
│   ├── flake.lock
│   └── README.md
├── edit-surface/        # NEW — mcp-contextual-code-edit
│   ├── flake.nix        # (README.md already exists)
│   ├── flake.lock
│   └── README.md
├── sqlite-store/        # NEW — sqlite-memory-mcp
│   ├── flake.nix
│   ├── flake.lock
│   └── README.md
├── nix-mcp-proxy/       # EXISTING — placeholder (README only)
└── docs-fetcher/        # EXISTING — placeholder (README only)

tests/
├── git-guard.sh
├── codebase.sh
├── web-browser.sh
├── task-runner.sh
├── test-runner.sh
├── edit-surface.sh
├── sqlite-store.sh
└── integration.sh       # claude-with-servers integration test

.github/
└── workflows/
    └── ci.yml           # Build + test all servers

flake.nix                # Root — imports all server flakes
scripts/claude-with-servers  # EXISTING — add new server entries
```

## Phase Dependencies

```
Phase 1 (Setup)
  └── Phase 2 (Server Packaging) — each server is [P]arallel
        └── Phase 3 (Root Integration) — after all servers
              └── Phase 4 (CI/CD)
                    └── Phase 5 (Polish)
```

Servers within Phase 2 are fully independent — they can be packaged in any order or in parallel. The RUNBOOK's priority order (git-guard first) is a recommendation, not a hard dependency.

## Testing Strategy

### Test scripts

Each `tests/<name>.sh` runs three levels:

```bash
#!/usr/bin/env bash
set -euo pipefail
BINARY="${1:-<name>}"

echo "=== Build test ==="
command -v "$BINARY" || { echo "FAIL: $BINARY not on PATH"; exit 1; }

echo "=== MCP initialize test ==="
RESP=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  | timeout 10 "$BINARY" 2>/dev/null | head -1)
echo "$RESP" | jq -e '.result.protocolVersion' || { echo "FAIL: bad initialize response"; exit 1; }

echo "=== Tool listing test ==="
TOOLS=$(printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | timeout 10 "$BINARY" 2>/dev/null | tail -1)
echo "$TOOLS" | jq -e '.result.tools | length > 0' || { echo "FAIL: no tools found"; exit 1; }

echo "=== ALL PASSED ==="
```

Servers that need CLI flags for stdio mode will adjust the `$BINARY` invocation.

### Integration test

`tests/integration.sh` verifies `claude-with-servers` generates a valid `.mcp.json`:

```bash
#!/usr/bin/env bash
set -euo pipefail
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
# Run build_mcp_config only (no exec claude)
MCP_TOOLBELT_PROJECT_DIR="$TMPDIR" bash -c '
  source <script-content>
  build_mcp_config
'
jq -e '.mcpServers | keys | length > 0' "$TMPDIR/.mcp-toolbelt/mcp.json"
echo "=== Integration test PASSED ==="
```

### Test plan matrix

| SC | Test Tier | Fixture | Assertion | Infrastructure |
|----|-----------|---------|-----------|----------------|
| SC-001 | Unit (per-server) | None | `nix build` exit 0 | Nix |
| SC-002 | Integration (per-server) | MCP JSON-RPC messages | Valid `protocolVersion`, tools > 0 | Nix + jq + timeout |
| SC-003 | Integration (root) | None | All packages accessible | Nix |
| SC-004 | Integration (launcher) | Temp dir | Valid `.mcp.json` with all servers | Nix + jq |
| SC-005 | Integration (launcher) | Env var set to 0 | Server absent from `.mcp.json` | Nix + jq |
| SC-006 | Integration (all) | All test scripts | All exit 0 | Nix |
| SC-007 | Manual review | N/A | README has required sections | Human |

### Pre-PR gate

```makefile
.PHONY: check
check:
	@for test in tests/*.sh; do echo "--- $$test ---"; bash "$$test" || exit 1; done
	@echo "=== ALL CHECKS PASSED ==="
```

## Interface Contracts

| IC | Name | Producer | Consumer(s) | Specification |
|----|------|----------|-------------|---------------|
| IC-001 | Server flake output | `servers/<name>/flake.nix` | Root `flake.nix` | `packages.${system}.default` = derivation; `packages.${system}.<name>` = same |
| IC-002 | Binary name | Server `meta.mainProgram` | `claude-with-servers`, test scripts | Exact binary name used by `command -v` |
| IC-003 | MCP stdio | Server binary | Claude Code | JSON-RPC 2.0 over stdin/stdout; responds to `initialize` and `tools/list` |
| IC-004 | Env toggle | `claude-with-servers` | User | `MCP_TOOLBELT_<UPPER_NAME>=0` disables; default enabled |
| IC-005 | Flake input | Root `flake.nix` | Consumer projects | `<name>.url = "path:./servers/<name>"; <name>.inputs.nixpkgs.follows = "nixpkgs"` |

## Critical Path (User Perspective)

**Day-1 flow**: User adds `mcp-toolbelt` to their `flake.nix` → enters `nix develop` → runs `claude-with-servers` → Claude Code has MCP tools from all servers.

1. Phase 1 (Setup): test infrastructure exists
2. Phase 2 (any single server): `nix build .#<server>` works → first testable result
3. Phase 3 (root integration): `claude-with-servers` picks up the new server → day-1 flow works for that server
4. Phase 2+3 repeated for all servers → full toolbelt

**First testable user result**: Phase 2, first server (git-guard). A user can `nix build .#mcp-server-git` and get a working MCP server binary.

## CI/CD

### GitHub Actions workflow

```yaml
name: CI
on: push

jobs:
  build-servers:
    strategy:
      matrix:
        server: [git-guard, codebase, web-browser, task-runner, test-runner, edit-surface, sqlite-store]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cachix/install-nix-action@v30
      - run: nix build .#${{ matrix.server }}

  test-servers:
    needs: build-servers
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cachix/install-nix-action@v30
      - run: nix develop --command bash -c 'for t in tests/*.sh; do bash "$t" || exit 1; done'

  integration:
    needs: build-servers
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cachix/install-nix-action@v30
      - run: nix develop --command bash tests/integration.sh
```

## Complexity Tracking

No constitution violations. All decisions follow the simplest viable approach.

| Decision | Complexity Level | Justification |
|----------|-----------------|---------------|
| Shell test scripts | Minimal | No framework dependency, 3 tests per server |
| One flake per server | Moderate (7 flakes) | Required by Constitution III (Composable Independence) |
| Playwright wrapper for web-browser | Higher | Unavoidable — Chromium is a hard runtime requirement |

## Per-Server Research Notes

Research for each server happens at implementation time (Phase 2). For each server, the implementing agent MUST:

1. Browse the upstream repo to identify: latest release tag, entry point binary, runtime deps, stdio mode flags, license
2. Write the flake using the appropriate builder
3. Run the 3-level test
4. Document findings in the server's README

This is documented in the RUNBOOK's "Per-server steps" checklist (Steps 1-10).
