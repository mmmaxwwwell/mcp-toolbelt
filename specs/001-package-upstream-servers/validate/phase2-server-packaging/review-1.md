# Phase phase2-server-packaging — Review #1: REVIEW-CLEAN

**Date**: 2026-06-01T12:30:00Z
**Assessment**: Code is clean. No bugs, security issues, or correctness problems found.

## Review methodology

1. **Re-ran all 9 test scripts** independently to verify the validate agent's claims. All 9 passed with identical results:
   - `tests/git-guard.sh` — PASS (12 tools)
   - `tests/codebase.sh` — PASS (4 tools)
   - `tests/web-browser.sh` — PASS (7 tools, Level 4 sidecar contract)
   - `tests/web-search.sh` — PASS (1 tool)
   - `tests/task-runner.sh` — PASS (2 tools)
   - `tests/test-runner.sh` — PASS (1 tool)
   - `tests/edit-surface.sh` — PASS (4 tools)
   - `tests/sqlite-store.sh` — PASS (9 tools)
   - `tests/integration.sh` — PASS (9 servers in `.mcp.json`)

2. **Spec-conformance check**: Verified all 29 phase tasks (T005–T033) against their "Done when" criteria. All server flakes export correct packages, use appropriate builders (`buildPythonApplication`, `buildNpmPackage`, `buildRustPackage`), include `meta`, and are pinned to specific versions/commits. Sidecar schema, FTS5 triggers, DB path, WAL mode, tool names all match spec exactly.

3. **Test-depth audit**: No skip guards, no mocking, non-vacuous assertions (specific field values, marker text, protocol versions, tool counts). Tests use temp directories for isolation.

4. **Bug scan**: Grepped for TODO/FIXME/stub/fake/hardcoded in all `.ts`, `.nix`, `.sh` files — clean. Reviewed sidecar TypeScript for SQL injection (uses parameterized queries), command injection (none), error handling (proper). Reviewed all 8 server `flake.nix` files for correctness.

## Substrate audits

- **Proof artifacts**: No `test-logs/` directory exists. This is expected — the project is a Nix packaging project using shell-script tests, not a web/app project with structured test reporters. The proof is the test exit codes and output, which I re-derived by running all tests.
- **Silent-skip check**: All test scripts use `set -euo pipefail` and fail loudly on any assertion failure.
- **Vacuous-test check**: Tests send real JSON-RPC requests and assert specific field values, not just truthiness.
- **Coverage matrix**: Every server added in the diff has a corresponding test script that exercises build, initialize, and tools/list. The sidecar additionally tests the full fetch→cache→search→get→purge contract.

## Deferred (optional improvements, not bugs)

- `claude-with-servers` contains `start_server()` and `cleanup()` functions that are never called (the script generates config then `exec`s claude, which manages server lifecycles itself). Harmless dead code.
- `web-search/flake.nix` meta omits `license` field (upstream license status may be unclear).
