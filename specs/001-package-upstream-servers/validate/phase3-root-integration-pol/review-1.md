# Phase phase3-root-integration-pol — Review #1: REVIEW-CLEAN

**Date**: 2026-06-01T12:45:00Z
**Assessment**: Code is clean. No bugs, security issues, or correctness problems found.

## Substrate audits

### Audit 1: Proof artifacts
No `test-logs/` directory exists. This project uses shell scripts as tests (not a framework with structured JSON reporters). Tests produce PASS/FAIL lines and use exit codes. The Makefile aggregates results. No proof-discipline violation — the project has no test reporter that would emit `test-logs/` artifacts.

### Audit 2: Disabled failure modes
`env-toggles.sh:58` uses `|| true` after invoking `claude-with-servers`. This is NOT a disabled failure mode: the `|| true` handles the subprocess exit while the actual assertions on lines 61-73 verify config file existence and JSON content. All assertions test real behavior.

### Audit 3: Route/screen coverage matrix
Not applicable — this is a Nix packaging/integration phase with no UI routes or screens.

### Audit 4: Claims vs substrate
All claims re-derived from substrate:
- **T034**: Claims nix build succeeds → verified: all binaries exist in `/nix/store/` (visible in `make check` output)
- **T035**: Claims 9 servers in `.mcp.json` → verified: `make check` output shows "PASS: all 9 expected servers present"
- **T036**: Claims 9 env toggles work → verified: `make check` output shows 9 individual PASS lines
- **T037**: Claims README updated → verified: all 8 new servers show "packaged" status in README.md
- **T038**: Claims `make check` passes → verified: re-ran `make check`, exit code 0, all 11 scripts pass
- Minor inconsistency: T038 claim says "10 test scripts" but 11 files run (lib.sh is a library, not a test). Not substantive.

## Spec-conformance check
- **T034**: Root flake builds all server inputs. Task says "7 new" but 8 were packaged (sqlite-store included). Exceeds spec. ✓
- **T035**: Integration test verifies all 9 servers by name (task says "7+1" = 8, but 9 present including sqlite-store). Exceeds spec. ✓
- **T036**: All 9 env var toggles tested individually with concrete assertions. ✓
- **T037**: README catalog updated: 6 status changes + 2 new rows (codebase, task-runner). All have "packaged" status and hyperlinks. ✓
- **T038**: `make check` passes, all 11 test scripts exit 0 with concrete assertions. ✓

## Test-depth audit
- **No skip guards**: No `describe.skip`, no conditional test gates, no swallowed setup errors.
- **Correct tier placement**: Shell integration tests in `tests/` — appropriate for this project type.
- **Non-vacuous assertions**: Tests check specific server names in JSON (not just `length > 0`), specific tool counts (12, 4, 9, etc.), specific protocol versions.
- **No internal mocking**: The fake `claude` stub is at the outer edge (prevents executing real Claude CLI). Server detection and config generation use real nix store binaries.
- **Error-path coverage**: N/A — no new endpoints or handlers. Phase tasks are verification-only.
- **Shared-runtime safety**: Each test creates its own `mktemp -d` with a cleanup trap. No shared state.

## Bug scan
Reviewed all 10 changed files in the diff:
- **README.md**: Status and hyperlink updates only. Correct.
- **tests/env-toggles.sh**: Clean shell script. Proper isolation, concrete assertions, no security issues.
- **tests/integration.sh**: Added EXPECTED_SERVERS array and per-server verification. The `SERVER_COUNT >= 1` check (line 75) is redundant with the per-name check but harmless.
- **claims/*.json, tasks.md, learnings.md**: Metadata updates only. No issues.

No bugs, security vulnerabilities, or correctness issues found.

**Deferred** (optional improvements, not bugs):
- The redundant `SERVER_COUNT >= 1` check in `integration.sh` could be removed since step 5b verifies each server by name. Not worth changing.
- `lib.sh` runs as a test script (exits 0 doing nothing) — could be excluded from `tests/*.sh` glob by moving to `tests/lib/` or using a different naming convention. Minor.
