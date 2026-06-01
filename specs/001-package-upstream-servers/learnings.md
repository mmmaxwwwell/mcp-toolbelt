# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T034 — verify root flake.nix builds
- All 7 new server inputs (git-guard, codebase, web-browser, web-search, task-runner, test-runner, edit-surface) plus sqlite-store build cleanly from the root flake — no code changes needed.
- The `flake.lock` has no duplicate `nixpkgs`/`flake-utils` nodes, confirming all `follows` directives are working correctly.
- Verification-only task: `nix flake show` + `nix build` for all 10 packages + devShell all exit 0.

## T035 — integration test with all servers
- The task says "7+1 (code-graph)" but there are actually 9 servers in the devShell: 8 new (git-guard, codebase, web-browser, web-search, task-runner, test-runner, edit-surface, sqlite-store) + code-graph. The `github-mcp-server` entry in `claude-with-servers` is not packaged by this project, so it doesn't appear.
- The Nix-installed copy of `claude-with-servers` is used by the test (via PATH from devShell), not the local `scripts/claude-with-servers` source. Changes to the source require a Nix rebuild to be reflected.
- The `.mcp.json` server keys don't always match binary names: e.g., `web-browser` key uses `web-browser-sidecar` binary, `sqlite-store` key uses `sqlite-memory-mcp` binary.

## T036 — env var toggle tests
- The `env` command accepts `"${var}=0"` as a single argument to set env vars dynamically in bash — useful for iterating over a mapping of toggle names to server keys.
- All 9 toggles (CODE_GRAPH, CODEBASE, WEB_BROWSER, GIT_GUARD, WEB_SEARCH, TASK_RUNNER, EDIT_SURFACE, TEST_RUNNER, SQLITE_STORE) work correctly; `github-mcp-server` is excluded since it's not packaged by this project.

## T037 — README server catalog update
- The task says "7 servers" but 8 were actually packaged (7 new inputs + sqlite-store). The README catalog was also missing `codebase` and `task-runner` rows entirely — they needed to be added, not just status-updated.
- The previously "planned" entries (`git-guard`, `test-runner`, `sqlite-store`) had no hyperlinks to their server directories — added `[name](servers/name/)` links for consistency with existing entries.

## T039 — CI workflow
- The root flake exports 10 packages (9 servers + `claude-with-servers`). The matrix build covers all 10 to catch per-server build regressions independently.
- `cachix/install-nix-action@v31` is the latest stable version; `extra_nix_config` enables `nix-command flakes` experimental features needed for `nix build .#pkg` syntax.
- The test job uses `nix develop --command make check` (single invocation, acceptable in CI despite the "don't use nix develop --command repeatedly" rule which targets multiple sequential calls).
