# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T001 — tests/lib.sh
- Functions accept extra args after binary name (e.g. `--stdio`, `--repository .`) via `shift` + `"$@"` — per-server tests can pass server-specific flags without modifying lib.sh.
- `mcp_smoke_test` is a convenience wrapper running all 3 levels; per-server test scripts can call individual functions for finer control.

## T002 — tests/integration.sh
- `claude-with-servers` ends with `exec claude`, so tests need a stub `claude` on PATH (just `exit 0`) to test config generation without requiring the real Claude CLI.
- The config file lands at `$MCP_TOOLBELT_PROJECT_DIR/.mcp-toolbelt/mcp.json`, not `.mcp.json` in the project root.

## T003 — Makefile
- `$(wildcard tests/*.sh)` returns empty when no test files exist yet; the Makefile explicitly checks for this and fails rather than silently succeeding with zero tests.

## T005 — mcp-server-git research
- Version scheme switched from semver (0.x) to calver (YYYY.M.DD) at 2025.1.14. Latest PyPI release is 2026.1.14; pyproject.toml on GitHub still shows 0.6.2 — the monorepo CI overrides the version on publish.
- Source lives in a monorepo at `src/git/` — Nix fetch needs `sourceRoot` or PyPI sdist.
- `gitpython` requires `git` binary at runtime — must be on PATH or wrapped into the derivation.

## T006 — git-guard flake.nix
- `fetchPypi` with `pname = "mcp_server_git"` (underscores) fetches the sdist cleanly, avoiding the monorepo `sourceRoot` issue with `fetchFromGitHub`.
- The `mcp` Python package test suite fails in the Nix sandbox (same as code-graph); override with `doCheck = false`.
- `NIX_REMOTE=daemon` is needed when running `nix build` as a non-root user in this environment (the nix db is owned by `nobody`).

## T007 — tests/git-guard.sh
- `mcp-server-git` requires `--repository <path>` to operate; without it, initialize hangs or errors. Use the mcp-toolbelt repo root as the target.
- `mcp_smoke_test` handles all 3 levels (build, initialize, tools/list) in one call — extra args after the binary name are forwarded correctly.

## T008 — root flake wiring for git-guard
- The `follows` pattern for sub-flakes needs both `nixpkgs` and `flake-utils` to follow the root inputs — omitting `flake-utils` causes a duplicate input evaluation.
- `nix flake show` automatically updates `flake.lock` when a new path input is added — no manual `nix flake lock --update-input` needed.

## T009 — claude-with-servers git-guard entry
- The git-guard entry was pre-populated in `scripts/claude-with-servers` by an earlier task but used `MCP_TOOLBELT_GIT` instead of the spec-required `MCP_TOOLBELT_GIT_GUARD`. The IC-004 contract requires `MCP_TOOLBELT_<UPPER_NAME>` naming.
- The integration test (`tests/integration.sh`) runs the Nix-installed copy of `claude-with-servers`, not the local source — changes to `scripts/claude-with-servers` require a Nix rebuild to be reflected in the installed binary.

## T010 — tree-sitter-mcp research
- Package is **not published to npm** — must use `fetchFromGitHub` for Nix packaging. The npm scope is `@nendo/tree-sitter-mcp` but no versions are on the registry.
- Native tree-sitter grammar packages (tree-sitter-c, tree-sitter-cpp, etc.) contain `.node` native addons requiring `node-gyp` + `python3` at build time — this will be the main packaging challenge.
- License is **GPL-3.0** (not MIT like most MCP servers) — may need user confirmation on license compatibility with the toolbelt.

## T011 — codebase flake.nix
- `buildNpmPackage` needs `makeCacheWritable = true` for tree-sitter-mcp — npm's cache inside the Nix store is read-only by default, and the native addon compilation writes to it.
- Despite T010 noting tree-sitter grammars as the "main packaging challenge," `buildNpmPackage` handles `node-gyp` natively with just `python3` and `pkg-config` in `nativeBuildInputs` — no special `node-gyp` override needed.
- The `--mcp` flag is required to start the MCP stdio server; without it, the CLI expects a subcommand.

## T012 — tests/codebase.sh
- `tree-sitter-mcp` prints `[INFO] MCP server started successfully` to stdout before JSON-RPC responses, so `mcp_smoke_test` (which uses `head -1`) fails. The test must filter non-JSON lines with `grep '^\s*{'` instead.
- The binary name is `tree-sitter-mcp` (matches `meta.mainProgram` in the flake).

## T013 — root flake wiring for codebase
- The `claude-with-servers` entry for tree-sitter-mcp was pre-populated by an earlier design task but was missing the `--mcp` flag — without it the binary expects a subcommand and hangs. Always cross-check args against the test script.
- Same `follows` pattern as git-guard: both `nixpkgs` and `flake-utils` must follow root inputs.

## T015 — fetcher-mcp flake.nix
- `fetcher-mcp` has a `postinstall: "playwright install chromium"` that fails in the Nix sandbox. Both `env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"` AND `npmFlags = ["--ignore-scripts"]` are needed — the env var alone is insufficient because the postinstall still runs and tries to resolve Playwright download URLs.
- No GitHub releases or tags exist for `fetcher-mcp` — pin to the commit hash matching the npm v0.3.9 publish (`8754aff66e3d`). Use `fetchFromGitHub` since the repo has `package-lock.json`.
- Use `symlinkJoin` + `wrapProgram` (not `makeWrapper` in `buildNpmPackage.nativeBuildInputs`) to wrap the binary with `PLAYWRIGHT_BROWSERS_PATH` pointing to `pkgs.playwright-driver.browsers`. This keeps the unwrapped derivation cacheable and the wrapper clean.

## T014 — mcp-read-website-fast research
- The npm package is `@just-every/mcp-read-website-fast` (scoped under `@just-every`). Published to npm unlike tree-sitter-mcp — can use npm registry for Nix `fetchurl` or `buildNpmPackage`.
- No GitHub releases exist — only git tags (latest: `v0.1.22`). Pin to the tag for Nix packaging.
- Default command with no args is `serve` (MCP stdio mode) — no special flags needed. The `serve-restart.ts` wrapper adds auto-restart with exponential backoff around the base `serve.ts` stdio server.
- Disk cache defaults to `.cache` in CWD. Only configurable via `--cache-dir` CLI flag on the `fetch`/`clear-cache` subcommands — no env var exists. For Nix wrapping, may need `makeWrapper` to set `--cache-dir` to a stable location.

## T015a — web-browser sidecar
- `better-sqlite3` requires `makeCacheWritable = true` and `python3` + `pkg-config` in `nativeBuildInputs` for its node-gyp native addon build — same pattern as tree-sitter-mcp.
- The MCP SDK's `StdioClientTransport` handles spawning and connecting to the child process; the sidecar just wraps the child's tools list and intercepts tool call results — no manual JSON-RPC framing needed.
- The sidecar binary must be wrapped with `--prefix PATH` pointing to the fetcher-mcp wrapper (not the unwrapped version) so Playwright environment variables propagate correctly to the child.

## T017 — root flake wiring for web-browser
- The `claude-with-servers` entry was pre-populated pointing at `fetcher-mcp` directly; the task requires it to point at `web-browser-sidecar` instead. The MCP server name in `.mcp.json` should be `web-browser` (matching the slot name), not `fetcher-mcp`.
- Same `follows` pattern as git-guard and codebase: both `nixpkgs` and `flake-utils` must follow root inputs.

## T016 — tests/web-browser.sh
- Playwright browser revision mismatch: `pkgs.playwright-driver.browsers` provides revision 1217 but fetcher-mcp's Playwright 1.51.1 expects revision 1161 with a different directory layout (`chrome-linux/headless_shell` vs `chrome-headless-shell-linux64/chrome-headless-shell`). Fixed via a `playwrightBrowsersCompat` derivation that creates symlink compat dirs.
- Bash's `read` without `-r` interprets backslash escapes, destroying JSON containing `\n` or `\_` sequences. Always use `read -r` when reading JSON-RPC responses.
- FTS5 tokenizes on underscores and hyphens, so test markers should be single contiguous tokens (e.g. `xyzzymcptest9f3a`) to avoid false negatives in `MATCH` queries.

## T017a — root flake wiring for web-search
- The web-search wiring (root flake.nix input + follows, package re-export, devShell inclusion, claude-with-servers entry with `MCP_TOOLBELT_WEB_SEARCH` toggle) was pre-populated by earlier design/implementation tasks (T015a and T017). Verification-only task — no code changes needed.
- The `web-search` binary takes no args for MCP stdio mode, matching the empty `args: []` in the claude-with-servers entry.

## T018 — shell-mcp research
- Upstream is `devrelopers/shell-mcp` (Rust). Two tags exist: v0.1.0 and v0.1.1 (both 2026-04-30). Pin to v0.1.1 (`a377286`).
- `--root <PATH>` or `SHELL_MCP_ROOT` env var is **required** — the server refuses to start without it. The `claude-with-servers` entry must pass `--root` pointing at the project directory.
- Uses `rmcp` crate (not the official `mcp-sdk-rs`) with `transport-io` feature for stdio. No special flags needed for MCP mode — just run the binary with `--root`.

## T019 — task-runner flake.nix
- Upstream `devrelopers/shell-mcp` has **no `Cargo.lock`** in the repo. Must generate one locally (`cargo generate-lockfile`) and use `cargoLock.lockFile = ./Cargo.lock` + `postPatch` to copy it into the source. Cannot use `cargoHash` without a lockfile.
- The tag `v0.1.1` is an annotated tag (not a lightweight one), but `fetchFromGitHub` resolves it correctly to commit `a377286`.

## T020 — tests/task-runner.sh
- `shell-mcp` logs (`INFO` lines from `tracing`) go to stderr, not stdout — unlike `tree-sitter-mcp`. Standard `mcp_smoke_test` works without filtering; no custom handlers needed.
- `--root <path>` is mandatory; use the repo root like `git-guard` uses `--repository`.

## T021 — root flake wiring for task-runner
- The `claude-with-servers` entry for shell-mcp was pre-populated but used `--project-dir` instead of the correct `--root` flag. Always cross-check args against the upstream README and test scripts (T018/T020 learnings already documented `--root` as mandatory).
- Same `follows` pattern as all prior servers: both `nixpkgs` and `flake-utils` must follow root inputs.

## T022 — mcp-test-runner research
- **Not published to npm** — must use `fetchFromGitHub`. The `package.json` name is `@modelcontextprotocol/server-test-runner` but no versions exist on the registry.
- No tags or releases on GitHub — pin to latest commit on main (`83c84ed053f5`, 2025-11-09). Similar to web-search (single-pin strategy).
- No `bin` field in `package.json` — entry point is `build/index.js` with a shebang. Will need custom `installPhase` or a bin wrapper in the Nix derivation.

## T023 — test-runner flake.nix
- The abbreviated commit hash in the T022 README (`83c84ed053f5`) was expanded incorrectly to `83c84ed053f5b5086d3a3eeed79c7bd939cd371c` — the actual full hash is `83c84ed053f534774f7de935aeaa7698a5e5f9dc`. Always verify full commit hashes via the GitHub API rather than guessing the suffix.
- Since `package.json` has no `bin` field, the `installPhase` must manually create the wrapper script. The wrapper needs an absolute path to `${pkgs.nodejs}/bin/node` — using just `node` fails at runtime because the Nix store binary has no `node` on PATH.
- No native addons or special build flags needed — `buildNpmPackage` with `npmBuildScript = "build"` (runs `tsc`) works cleanly.

## T014a — web-search research
- The upstream repo uses **Google scraping** (axios + cheerio), not DuckDuckGo as assumed in the design. The spec/design docs reference DDG but the actual implementation scrapes Google search HTML.
- **No license** exists on the repo — no LICENSE file, no `license` field in package.json, GitHub API returns `null`. This is a legal risk for redistribution; documented in README with upgrade paths to licensed alternatives.
- Single-commit repo (`1b3ead8`, 2024-12-30) with no tags or releases. Pin to this commit hash for `fetchFromGitHub`.

## T024 — tests/test-runner.sh
- `mcp-test-runner` needs no special flags for stdio MCP mode — simplest test script of all servers. Just `mcp_smoke_test "mcp-test-runner"` with no extra args.
- The single exposed tool is `run_tests` (confirmed via tools/list returning count=1).

## T025 — root flake wiring for test-runner
- The `claude-with-servers` entry was pre-populated with `--project-dir $dir` args, but `mcp-test-runner` takes no flags for stdio MCP mode. Fixed to empty args `[]`. Always cross-check pre-populated entries against the test script and upstream README.
- Same `follows` pattern as all prior servers: both `nixpkgs` and `flake-utils` must follow root inputs.

## T026 — mcp-contextual-code-edit research
- The spec references `metaphorics/mcp-contexual-code-edit` (typo: "contexual"), which is a fork of the canonical `jbr/semantic-edit-mcp`. The fork is behind (only v0.1.2 vs upstream v0.2.1) and adds no value — pin to the upstream `jbr/semantic-edit-mcp` instead.
- Published to crates.io as `semantic-edit-mcp`. `Cargo.lock` is present on tagged releases (unlike `shell-mcp` which had none). Use `fetchFromGitHub` + `cargoLock.lockFile` from the source.
- No special flags for stdio MCP — just run the binary directly. Optional `serve` subcommand also works but isn't required (default behavior is to serve).

## T027 — edit-surface flake.nix
- Unlike `shell-mcp` (T019), `semantic-edit-mcp` has `Cargo.lock` on tagged releases — no need to generate one. Copy it from the fetched source into the flake directory and use `cargoLock.lockFile = ./Cargo.lock`.
- Upstream snapshot tests (`run_snapshot_tests`) fail in the Nix sandbox due to read-only filesystem constraints. `doCheck = false` is needed, same pattern as other servers (T006).
- No git dependencies in `Cargo.lock` — pure crates.io deps, so no `outputHashes` needed for `cargoLock`.

## T028 — tests/edit-surface.sh
- `semantic-edit-mcp` requires the `serve` subcommand for MCP stdio mode — without it, it shows help text listing subcommands (preview-edit, retarget-edit, persist-edit, set-working-directory). The `--help` does not mention `serve` but it works.
- The server exposes 4 tools (preview_edit, retarget_edit, persist_edit, set_working_directory).
