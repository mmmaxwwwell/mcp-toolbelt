# Tasks: Package Upstream MCP Servers

**Input**: `specs/001-package-upstream-servers/plan.md`, `spec.md`, `research.md`
**Preset**: local
**Approach**: TDD with fix-validate loop per phase. Minimum viable packaging per Constitution VII. One commit per server. No auth, no network hardening — Nix packaging project. See Non-Goals for intentional omissions.

## Phase 1: Setup (Test Infrastructure)

**Purpose**: Test scripts and CI foundation before any server packaging.

- [x] T001 [P] Create test helper script `tests/lib.sh` with shared MCP smoke test functions (initialize, tools/list) used by all per-server test scripts. Extract the 3-level test pattern from RUNBOOK into reusable functions. [FR-014, FR-015] [produces: IC-003]
- [x] T002 [P] Create integration test `tests/integration.sh` that verifies `claude-with-servers` generates valid `.mcp.json` with all available servers. Must work with whatever servers are currently on PATH. [FR-011, FR-012, SC-004]
- [x] T003 [P] Create `Makefile` with `check` target that runs all `tests/*.sh` scripts. [SC-006]
- [x] T004 [P] Update `.gitignore` with spec-kit baseline entries (test-logs/, logs/, validate/, attempts/, .env, node_modules/, dist/, result, *.db). [FR-007]

**Checkpoint**: Test infrastructure exists. All subsequent server tasks will create a test script that uses `tests/lib.sh`.

Done criteria:
- `tests/lib.sh` defines `mcp_initialize_test()` and `mcp_tools_list_test()` functions
- `tests/integration.sh` runs and passes (with existing code-graph server)
- `make check` runs all tests
- `.gitignore` updated

---

## Phase 2: Server Packaging

**Purpose**: Package each upstream server into an independent Nix flake following the `servers/code-graph/` pattern.

Each server task includes: upstream research, `flake.nix`, test script, `README.md` update, root flake wiring, `claude-with-servers` entry.

### git-guard (mcp-server-git) — Python

- [x] T005 [P] Research upstream `mcp-server-git`: find latest PyPI release tag, identify entry point binary name, check runtime deps, determine stdio mode flags, verify MIT license. Record in `servers/git-guard/README.md`. [FR-007]
- [x] T006 Package `mcp-server-git` as `servers/git-guard/flake.nix` using `buildPythonApplication`. Pin to latest release + content hash. Export `packages.default` and `packages.mcp-server-git`. Include `meta`. [FR-001, FR-002, FR-003, FR-004] [produces: IC-001, IC-002]
- [x] T007 Create `tests/git-guard.sh` using `tests/lib.sh` functions. Verify build, MCP initialize, and tools/list. [FR-005, FR-006, FR-014, SC-002]
- [x] T008 Wire `git-guard` into root `flake.nix`: add path input with follows, re-export package, add to devShell. [FR-008, FR-009, FR-010] [consumes: IC-001]
- [x] T009 Add `git-guard` entry to `scripts/claude-with-servers`: auto-detect `mcp-server-git` binary, add env toggle `MCP_TOOLBELT_GIT_GUARD`, generate `.mcp.json` entry with correct args. [FR-011, FR-012, FR-013] [consumes: IC-002, produces: IC-004]

**Checkpoint**: `nix build .#mcp-server-git` works, `tests/git-guard.sh` passes, `claude-with-servers` detects it.

Done criteria:
- `nix build .#mcp-server-git` produces a working binary
- `tests/git-guard.sh` passes all 3 levels
- Root flake exports the package
- `claude-with-servers` includes it in `.mcp.json`

---

### codebase (tree-sitter-mcp) — TypeScript

- [x] T010 [P] Research upstream `tree-sitter-mcp`: find latest release tag, identify entry point, check npm deps, determine stdio flags, verify license. Record in `servers/codebase/README.md`. [FR-007]
- [x] T011 Package `tree-sitter-mcp` as `servers/codebase/flake.nix` using `buildNpmPackage`. Pin to release + hash. Export packages. Include `meta`. [FR-001, FR-002, FR-003, FR-004] [produces: IC-001, IC-002]
- [x] T012 Create `tests/codebase.sh`. [FR-005, FR-006, FR-014, SC-002]
- [x] T013 Wire into root `flake.nix` + `claude-with-servers`. [FR-008, FR-009, FR-010, FR-011, FR-012, FR-013] [consumes: IC-001, IC-002, produces: IC-004]

**Checkpoint**: `nix build .#tree-sitter-mcp` works, tests pass, launcher detects it.

Done criteria:
- Same as git-guard checkpoint, for tree-sitter-mcp binary

---

### web-browser (fetcher-mcp + FTS5 sidecar) — TypeScript + Playwright

The `web-browser` slot is a **sidecar MCP server** that wraps the upstream `jae-jae/fetcher-mcp`. The sidecar speaks MCP to the agent, spawns `fetcher-mcp` as a child process over stdio, passes fetch calls through, and on success writes the extracted markdown to a user-global SQLite FTS5 store at `~/.cache/mcp-toolbelt/web-cache.db`. The sidecar adds four tools on top of the upstream's surface: `search_cached`, `get_cached`, `list_cached`, `purge_cached`. Upstream is unforked — bumping fetcher-mcp is a hash bump in this flake.

- [x] T014 [P] Research upstream `just-every/mcp-read-website-fast`: find latest release tag, identify entry point binary name, check npm deps, determine stdio mode flags, verify MIT license, note disk-cache location config (env var or CLI flag). Record in `servers/web-browser/README.md`. [FR-007]
- [x] T015 Package `fetcher-mcp` as a Nix derivation under `servers/web-browser/flake.nix` using `buildNpmPackage`. Wrap the resulting binary with `makeWrapper`, setting `PLAYWRIGHT_BROWSERS_PATH` to `pkgs.playwright-driver.browsers` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Pin to release + hash. Export `packages.fetcher-mcp` for the wrapped upstream binary. [FR-001, FR-002, FR-003, FR-004] [produces: IC-001]
- [x] T015a Implement the sidecar MCP server in `servers/web-browser/sidecar/` (TypeScript, Node 22). Responsibilities: (1) on `initialize`, forward to child fetcher-mcp and concatenate our four added tools into the `tools/list` response; (2) for upstream tools, forward request, intercept response, on success extract `{url, title, markdown}` and `INSERT OR REPLACE` into `pages` table; (3) for our four added tools, query SQLite directly and never touch the child. Use `better-sqlite3` (synchronous, embedded). Schema: `pages(id INTEGER PRIMARY KEY, url TEXT UNIQUE, title TEXT, fetched_at INTEGER, markdown TEXT)` + `pages_fts USING fts5(title, markdown, content='pages', content_rowid='id')` with triggers to keep them in sync. DB path: `${XDG_CACHE_HOME:-$HOME/.cache}/mcp-toolbelt/web-cache.db`. WAL mode. Export `packages.default` = the sidecar bin, with the wrapped `fetcher-mcp` on its PATH. [FR-001, FR-002, FR-003, FR-004] [produces: IC-001, IC-002]
- [x] T016 Create `tests/web-browser.sh` using `tests/lib.sh` functions. Verify build, MCP initialize on the sidecar, and `tools/list` (must include both upstream's fetch tools AND our four added tools — `search_cached`, `get_cached`, `list_cached`, `purge_cached`). Cover the sidecar contract: a) call upstream's fetch tool against a fixture URL → expect markdown + a row appears in the DB; b) call `search_cached(query)` for a term in that markdown → expect a hit; c) call `get_cached(url)` → expect the same markdown; d) call `purge_cached(url)` → expect the row gone. Use a temporary `XDG_CACHE_HOME` so tests don't pollute the user cache. [FR-005, FR-006, FR-014, SC-002]
- [x] T017 Wire into root `flake.nix` + `claude-with-servers`. Env toggle: `MCP_TOOLBELT_WEB_BROWSER`. The `.mcp.json` entry points at the sidecar binary, not fetcher-mcp directly. [FR-008, FR-009, FR-010, FR-011, FR-012, FR-013] [consumes: IC-001, IC-002, produces: IC-004]

**Checkpoint**: `nix build .#web-browser` works, sidecar starts fetcher-mcp as child, fetched pages land in `~/.cache/mcp-toolbelt/web-cache.db`, `search_cached` returns results.

Done criteria:
- Sidecar's `tools/list` exposes upstream's fetch tools + our four added tools
- After a real fetch, FTS5 `MATCH` query against the markdown returns the fetched page
- `get_cached(url)` and `purge_cached(url)` round-trip correctly
- Playwright Chromium loads without runtime download (no network egress for browser binaries)
- Forwarding latency: sidecar adds <50ms on cache-hit paths, <200ms on fetch paths

---

### web-search (pskill9/web-search) — TypeScript

- [x] T014a [P] Research upstream `pskill9/web-search`: find latest release tag (or pin to a commit if no releases), identify entry point, check npm deps, determine stdio flags, verify MIT license, document DuckDuckGo rate-limit behavior. Record in `servers/web-search/README.md`. Include opt-in upgrade docs for Tavily and Exa (env vars, install steps). [FR-007]
- [x] T015a Package `web-search` as `servers/web-search/flake.nix` using `buildNpmPackage`. Pin to release/commit + hash. Export packages. Include `meta`. [FR-001, FR-002, FR-003, FR-004] [produces: IC-001, IC-002]
- [x] T016a Create `tests/web-search.sh` using `tests/lib.sh` functions. Verify build, MCP initialize, and tools/list. Skip a live-network search assertion in CI (flaky); cover that in a separate manual script. [FR-005, FR-006, FR-014, SC-002]
- [x] T017a Wire into root `flake.nix` + `claude-with-servers`. Env toggle: `MCP_TOOLBELT_WEB_SEARCH`. [FR-008, FR-009, FR-010, FR-011, FR-012, FR-013] [consumes: IC-001, IC-002, produces: IC-004]

**Checkpoint**: `nix build .#web-search` works, tests pass, launcher detects it.

Done criteria:
- Same as git-guard checkpoint, for the web-search binary
- README documents both default (DDG) and opt-in (Tavily/Exa) configurations

---

### task-runner (shell-mcp) — Rust

- [x] T018 [P] Research upstream `shell-mcp`: find latest release, identify entry point, check cargo deps, determine stdio flags, verify license. Record in `servers/task-runner/README.md`. [FR-007]
- [x] T019 Package `shell-mcp` as `servers/task-runner/flake.nix` using `buildRustPackage`. Pin to release + `cargoHash`. Export packages. Include `meta`. [FR-001, FR-002, FR-003, FR-004] [produces: IC-001, IC-002]
- [x] T020 Create `tests/task-runner.sh`. [FR-005, FR-006, FR-014, SC-002]
- [x] T021 Wire into root `flake.nix` + `claude-with-servers`. [FR-008, FR-009, FR-010, FR-011, FR-012, FR-013] [consumes: IC-001, IC-002, produces: IC-004]

**Checkpoint**: `nix build .#shell-mcp` works, tests pass, launcher detects it.

Done criteria:
- Same as git-guard checkpoint, for shell-mcp binary

---

### test-runner (mcp-test-runner)

- [x] T022 [P] Research upstream `mcp-test-runner`: determine language/build system, find latest release, identify entry point, check deps, determine stdio flags, verify license. Record in `servers/test-runner/README.md`. [FR-007]
- [x] T023 Package `mcp-test-runner` as `servers/test-runner/flake.nix` using appropriate builder (TBD from research). Pin to release + hash. Export packages. [FR-001, FR-002, FR-003, FR-004] [produces: IC-001, IC-002]
- [x] T024 Create `tests/test-runner.sh`. [FR-005, FR-006, FR-014, SC-002]
- [x] T025 Wire into root `flake.nix` + `claude-with-servers`. [FR-008, FR-009, FR-010, FR-011, FR-012, FR-013] [consumes: IC-001, IC-002, produces: IC-004]

**Checkpoint**: Build, test, integrate — same pattern.

Done criteria:
- Same as git-guard checkpoint, for mcp-test-runner binary

---

### edit-surface (mcp-contextual-code-edit)

- [x] T026 [P] Research upstream `mcp-contextual-code-edit`: determine language/build system, find latest release, identify entry point, check deps, determine stdio flags, verify license. Record in `servers/edit-surface/README.md` (update existing). [FR-007]
- [x] T027 Package as `servers/edit-surface/flake.nix` using appropriate builder. Pin to release + hash. Export packages. [FR-001, FR-002, FR-003, FR-004] [produces: IC-001, IC-002]
- [x] T028 Create `tests/edit-surface.sh`. [FR-005, FR-006, FR-014, SC-002]
- [ ] T029 Wire into root `flake.nix` + `claude-with-servers`. [FR-008, FR-009, FR-010, FR-011, FR-012, FR-013] [consumes: IC-001, IC-002, produces: IC-004]

**Checkpoint**: Build, test, integrate.

Done criteria:
- Same as git-guard checkpoint, for mcp-contextual-code-edit binary

---

### sqlite-store (sqlite-memory-mcp)

- [ ] T030 [P] Research upstream `sqlite-memory-mcp`: determine language/build system, find latest release, identify entry point, check deps, determine stdio flags, verify license. Record in `servers/sqlite-store/README.md`. [FR-007]
- [ ] T031 Package as `servers/sqlite-store/flake.nix` using appropriate builder. Pin to release + hash. Export packages. [FR-001, FR-002, FR-003, FR-004] [produces: IC-001, IC-002]
- [ ] T032 Create `tests/sqlite-store.sh`. [FR-005, FR-006, FR-014, SC-002]
- [ ] T033 Wire into root `flake.nix` + `claude-with-servers`. [FR-008, FR-009, FR-010, FR-011, FR-012, FR-013] [consumes: IC-001, IC-002, produces: IC-004]

**Checkpoint**: Build, test, integrate.

Done criteria:
- Same as git-guard checkpoint, for sqlite-memory-mcp binary

---

## Phase 3: Root Integration & Polish

**Purpose**: Verify all servers work together and finalize docs.

- [ ] T034 Verify root `flake.nix` builds with all 7 new server inputs. Fix any input follows or version conflicts. [FR-008, SC-003]
- [ ] T035 Run `tests/integration.sh` with all servers on PATH. Verify `.mcp.json` contains all 7+1 (code-graph) servers. [SC-004]
- [ ] T036 Test env var toggles: for each server, set `MCP_TOOLBELT_<NAME>=0` and verify it's absent from `.mcp.json`. [FR-013, SC-005]
- [ ] T037 Update root `README.md`: change server catalog status from "planned"/"design only" to "packaged" for all 7 servers. [FR-007, SC-007]
- [ ] T038 Run `make check` — all tests must pass. [SC-006]

**Checkpoint**: Full toolbelt working. All tests pass.

Done criteria:
- `nix develop` provides all 8 server binaries (7 new + code-graph)
- `claude-with-servers` generates `.mcp.json` with all 8 servers
- All `tests/*.sh` pass
- `README.md` reflects current status

---

## Phase 4: CI/CD

**Purpose**: Automated build + test on push.

- [ ] T039 Create `.github/workflows/ci.yml` with matrix build (one job per server) + test job. Use `cachix/install-nix-action`. [SC-001, SC-006]
- [ ] T040 [P] Add Gitleaks pre-commit hook config (`.gitleaks.toml` or `.pre-commit-config.yaml`). [interview-notes: Tier 1 security]

**Checkpoint**: CI runs on push, all servers build and test green.

Done criteria:
- Push to main triggers CI
- All matrix jobs pass
- Gitleaks catches `sk_live_` patterns

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Server Packaging)**: Depends on T001 (test lib). All 7 servers are independent of each other (`[P]`-eligible across servers, sequential within each server: research → package → test → wire)
- **Phase 3 (Integration)**: Depends on ALL Phase 2 servers being complete
- **Phase 4 (CI/CD)**: Depends on Phase 3

### Within Each Server (Phase 2)

Sequential: Research (Txx5) → Package (Txx6) → Test (Txx7) → Wire (Txx8, Txx9)

Research must complete before packaging (need version, entry point, deps). Packaging must complete before testing (need the binary). Testing must pass before wiring into root flake.

### Parallel Opportunities

- All Phase 1 tasks are `[P]`
- All 7 server research tasks (T005, T010, T014, T018, T022, T026, T030) are `[P]`
- Server packaging across different servers is `[P]` (different directories, no shared resources)
- Phase 4 tasks are `[P]`
