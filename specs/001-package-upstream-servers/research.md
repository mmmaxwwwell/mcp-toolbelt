# Research: Package Upstream MCP Servers

**Date**: 2026-05-23

## Decisions

### 1. Per-server Nix builder selection

**Decision**: Use the idiomatic Nix builder for each upstream language.

| Server | Language | Builder | Rationale |
|--------|----------|---------|-----------|
| git-guard | Python (pip) | `buildPythonApplication` | Same pattern as code-graph; known to work |
| codebase | TypeScript (npm) | `buildNpmPackage` | Standard nixpkgs builder for npm projects |
| web-browser | TypeScript (npm) | `buildNpmPackage` + Playwright wrapper | Needs `PLAYWRIGHT_BROWSERS_PATH` pointing to `pkgs.playwright-driver.browsers` |
| task-runner | Rust (cargo) | `buildRustPackage` | Standard nixpkgs builder for Rust |
| test-runner | TBD | TBD | Needs upstream research — language/build system unknown |
| edit-surface | TBD | TBD | Needs upstream research |
| sqlite-store | TBD | TBD | Needs upstream research |

**Alternatives rejected**:
- Docker-based packaging — violates Constitution I (Nix-First)
- `mkDerivation` with manual build steps — builders exist for Python/npm/Rust; use them
- `dream2nix` / `poetry2nix` — more complex, standard builders sufficient for these upstreams

### 2. Testing approach

**Decision**: Shell scripts in `tests/<name>.sh`, no test framework.

**Rationale**: Constitution VI requires three specific test levels (build, initialize, tools/list). These are simple shell pipelines — a test framework adds dependency without value. Exit codes are sufficient. Structured output via `echo "=== <test> ==="` headers.

**Alternatives rejected**:
- Bats (bash testing framework) — adds a dependency for 3 tests per server
- Nix `flake check` with custom checks — harder to debug, less transparent
- Python pytest wrapper — overkill for shell pipelines

### 3. CI platform

**Decision**: GitHub Actions, single workflow file.

**Rationale**: Repo is on GitHub. Nix builds are cacheable via `cachix/install-nix-action`. Matrix strategy gives per-server parallelism. User chose direct-to-main, so only push trigger needed.

**Alternatives rejected**:
- Hydra (Nix-native CI) — heavyweight for a library project
- Self-hosted runners — unnecessary complexity
- Per-server workflows — one workflow with matrix is simpler

### 4. Playwright/Chromium for fetcher-mcp

**Decision**: Wrapper script that sets `PLAYWRIGHT_BROWSERS_PATH` to `pkgs.playwright-driver.browsers`.

**Rationale**: Playwright needs a browser binary. Nix can provide Chromium via `playwright-driver.browsers`. A `makeWrapper` derivation sets the env var so the binary finds Chromium without runtime downloads.

**Risk**: This is the hardest server to package. Playwright version in nixpkgs may not match the version fetcher-mcp expects. May need `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` at build time + version pinning.

### 5. Server priority order

**Decision**: Follow RUNBOOK order — easiest/most-value first.

**Rationale**: git-guard (Python) is most similar to code-graph (also Python, already packaged). Each subsequent server teaches a new builder pattern. web-browser is intentionally third despite being hardest because its value (token-efficient browsing) is high.

**User delegation**: User said "yolo" — all decisions delegated to agent best judgment.

### 6. Platform scope

**Decision**: Linux only (x86_64-linux, aarch64-linux).

**Rationale**: User explicitly said "nix only" and confirmed Linux-only. Avoids macOS-specific Playwright issues, Darwin SDK complications, and cross-platform testing burden.

### 7. stdio transport enforcement

**Decision**: Each server must run in stdio mode. Discover the right CLI flags per-server during research.

Common patterns:
- `--stdio` flag
- `--transport stdio` flag
- `serve` subcommand (defaults to stdio)
- No flag needed (stdio is default)

Document the correct invocation in each server's README and in `claude-with-servers`.

### 8. Version pinning strategy

**Decision**: Pin to the latest tagged release. Use `pkgs.fetchFromGitHub` with `rev = "v${version}"` and content hash. For PyPI-only packages, use `pkgs.fetchPypi`.

**Rationale**: Tagged releases are stable and reproducible. Content hash ensures builds are pure. Bumping versions means updating `version` + `hash` together (documented in each README).

**Edge case**: If an upstream has no tagged releases, pin to a specific commit hash and document it.