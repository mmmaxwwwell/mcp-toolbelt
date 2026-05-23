# mcp-toolbelt Design Document

## Vision

Replace Claude Code's built-in tools with MCP servers that **mechanically
pre-process** inputs and outputs — adding structure, caching, security scoping,
and token efficiency. The agent stops reading raw files, running raw shell
commands, and parsing raw HTML. Instead it calls high-level MCP tools that
return pre-digested, policy-compliant results.

## Tool Replacement Map

Every built-in Claude Code tool mapped to its MCP server replacement:

| Built-in Tool | MCP Server | What Changes |
|---|---|---|
| `Read` | `codebase` (tree-sitter-mcp) | Returns AST-enriched content with symbol outlines, type info, references. Path ACLs via proxy. |
| `Edit` | `edit-surface` (contextual-code-edit) | Validates syntax (tree-sitter), runs formatter, checks imports. Rejects edits outside allowed paths. |
| `Write` | `edit-surface` | Same. New files scaffolded with project conventions. |
| `Glob` | `codebase` | File discovery through the indexed AST + code-graph. No filesystem scanning. |
| `Grep` | `codebase` + `sqlite-store` | FTS5 over indexed codebase. Ranked results, instant — no cold-start scanning. |
| `Bash` | `task-runner` (shell-mcp) | Per-directory TOML allowlists. Only blessed commands (build, test, lint, format). Structured output. |
| `WebFetch` | `web-browser` (fetcher-mcp) | Real Playwright browser → Readability extraction → cached to FTS store. Token-efficient. |
| `WebSearch` | `web-browser` | Search → auto-fetch top results → extract → cache. Semantic discovery over browsed content. |
| `Bash (git)` | `git-guard` (mcp-server-git + proxy) | Scoped repos/branches/paths. Contributor identity stamped. Destructive ops blocked. Audit log. |
| `Agent` | *(keep as-is)* | Orchestration stays with the model. |
| `AskUserQuestion` | *(keep as-is)* | No replacement needed. |

## Server Catalog

### Tier 1 — Working / near-ready upstream

#### `code-graph` (existing)
- **Upstream:** [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph) v2.3.2
- **Status:** Working, already in the toolbelt.
- **Tools:** `get_minimal_context_tool`, `query_graph_tool`, `semantic_search_nodes_tool`, `detect_changes_tool`, `get_review_context_tool`
- **Replaces:** Deep codebase understanding that would otherwise require many Read + Grep calls.

#### `codebase` — Structure-aware code reading & search
- **Upstream:** [nendotools/tree-sitter-mcp](https://github.com/nendotools/tree-sitter-mcp) (TypeScript, npm)
- **What it does:** Parses code with tree-sitter, exposes semantic search (functions/classes/variables by name), usage tracing, quality analysis, dead code detection. Sub-100ms searches across 15+ languages.
- **Replaces:** `Read`, `Glob`, `Grep` — agent asks "find all functions that call X" instead of grepping.
- **Enhancement:** Pair with `sqlite-store` for FTS over file contents. Proxy scopes reads to allowed paths.

#### `web-browser` — Token-efficient browsing
- **Upstream:** [jae-jae/fetcher-mcp](https://github.com/jae-jae/fetcher-mcp) (TypeScript)
- **What it does:** Playwright headless browser renders pages with full JS, then runs Mozilla's Readability algorithm to extract just the meaningful content. Returns clean markdown, not raw HTML.
- **Replaces:** `WebFetch`, `WebSearch` — agent gets pre-digested content, not HTML soup.
- **Enhancement:** Cache extracted content to `sqlite-store` FTS5 so repeated lookups are free. Add a `search_browsed(query)` tool that searches previously fetched content.
- **Alternative:** [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) for interactive browsing (form filling, clicking), but 4x more tokens per interaction.

#### `git-guard` — Scoped, audited git operations
- **Upstream:** [modelcontextprotocol/servers — git](https://pypi.org/project/mcp-server-git/) (Python, official) + policy layer via `nix-mcp-proxy`
- **What it does:** Standard git operations (status, diff, commit, branch, log, push).
- **Replaces:** `Bash` for all git commands.
- **Enhancement via proxy:**
  - Scope to specific repos (agent can't `git clone` arbitrary URLs)
  - Branch restrictions (only push to feature branches, never main)
  - Path restrictions (agent can only commit changes to `src/`, not `infra/`)
  - Stamp contributor name/email on every commit
  - Block destructive ops (`force-push`, `reset --hard`, `rebase`)
  - Full audit log of every operation with intent

#### `github-api` — GitHub platform operations
- **Upstream:** [github/github-mcp-server](https://github.com/github/github-mcp-server) (Go, official)
- **What it does:** Issues, PRs, code search, releases, projects via GitHub API.
- **Complements:** `git-guard` (local git) + `github-api` (platform).
- **Security note:** Known prompt injection vector via issue/PR content — proxy should sanitize.

### Tier 2 — Need wrapping or building

#### `task-runner` — Scoped shell execution
- **Upstream:** [devrelopers/shell-mcp](https://github.com/devrelopers/shell-mcp) (Rust)
- **What it does:** Per-directory `.shell-mcp.toml` allowlists. Read-only commands (ls, git status, cargo metadata) allowed by default. Write commands require explicit config.
- **Replaces:** `Bash` — agent can run `npm test` and `npm run build` but not `rm -rf /`.
- **Enhancement:** Structured output parsing (detect JSON, JUnit XML, TAP in stdout and return parsed). Pre-configured task definitions in flake config.
- **Alternative:** [tumf/mcp-shell-server](https://github.com/tumf/mcp-shell-server) (Python, simpler env-var allowlist).

#### `edit-surface` — AST-aware code editing
- **Upstream:** [metaphorics/mcp-contextual-code-edit](https://github.com/metaphorics/mcp-contexual-code-edit) (newer project)
- **What it does:** Tree-sitter-based code editing that validates syntax before applying changes. Prevents file corruption.
- **Replaces:** `Edit`, `Write` — agent says "edit function X" instead of "replace this string".
- **Enhancement:** Add formatter integration (prettier, black, rustfmt) post-edit. Add import resolution.
- **Alternative:** [jonrad/lsp-mcp](https://github.com/jonrad/lsp-mcp) bridges a real LSP server → MCP, giving rename, go-to-definition, find-references, diagnostics. Powerful but requires running an LSP per language.

#### `test-runner` — Structured test execution
- **Upstream:** [privsim/mcp-test-runner](https://github.com/privsim/mcp-test-runner)
- **What it does:** Unified interface across Bats, Pytest, Jest, Go, Rust, Flutter. Returns structured results (pass/fail/skip per test, summaries).
- **Replaces:** `Bash` for `npm test`, `pytest`, `cargo test`, etc.
- **Enhancement:** Cache results keyed by file content hash — skip unchanged tests. Coverage delta tracking.

#### `sqlite-store` — Shared FTS5 storage backend
- **Upstream:** [RMANOV/sqlite-memory-mcp](https://github.com/RMANOV/sqlite-memory-mcp)
- **What it does:** SQLite with WAL mode, FTS5 BM25 search, session tracking. Concurrent-safe.
- **Purpose:** Shared storage for all other servers. Namespaced tables:
  - `codebase.*` — indexed file contents for FTS
  - `web.*` — cached browsed page content
  - `docs.*` — version-pinned dependency documentation
  - `memory.*` — persistent agent notes across sessions
- **Alternative:** [neverinfamous/db-mcp](https://github.com/neverinfamous/db-mcp) (139 tools — too many for LLM reasoning).

### Tier 3 — Design only

#### `docs-fetcher` — Version-pinned dependency docs
- **Status:** Design only (see `servers/docs-fetcher/README.md`).
- **What it does:** Reads manifests, fetches docs for exact dependency versions, stores in `sqlite-store`.
- **Replaces:** Agent hallucinating APIs from training data.

#### `security-policy` — Security guidelines as tooling
- **Status:** Concept.
- **What it does:** Exposes project-specific security rules. Runs lightweight static analysis on proposed changes (semgrep under the hood). Agent calls `check_change(diff)` before committing.
- **Replaces:** Security knowledge baked into prompts (unreliable) with mechanical enforcement.

### Cross-cutting: `nix-mcp-proxy`
- **Upstream:** [mmmaxwwwell/nix-mcp-proxy](https://github.com/mmmaxwwwell/nix-mcp-proxy) (in development)
- **Role:** Sits in front of every server above. Provides:
  - Tool whitelisting (expose only the tools you want per-project)
  - Path/field validation
  - Rate limiting
  - Audit logging (every tool call with timestamp, args, result hash)
  - Request shaping (rewrite args, inject defaults)

## Storage Architecture

All servers share a **single SQLite database per project** at
`.mcp-toolbelt/store.db` with FTS5 enabled and WAL mode for concurrency.

```
.mcp-toolbelt/
├── store.db          # shared SQLite + FTS5
├── code-graph/       # code-review-graph state (existing)
└── logs/             # audit logs from proxy
```

Each server writes to namespaced tables. No vector store — FTS5 handles
keyword/phrase search. If semantic similarity is later proven necessary, it can
be added as an optional layer to specific servers without changing the architecture.

## Token Efficiency Strategy

The core design principle: **every MCP tool call should return fewer tokens than
the built-in tool it replaces, while providing more useful information.**

| Pattern | Mechanism |
|---|---|
| Pre-digested content | Readability extraction (web), AST outlines (code), structured results (tests) |
| Caching | FTS5-indexed results keyed by content hash — previously seen content is instant |
| Scoping | Path/repo/branch restrictions mean the agent can't wander — fewer exploratory calls |
| Structured output | JSON with typed fields instead of raw stdout — agent parses less, reasons more |
| Deduplication | Track what the agent has already read this session — skip re-reads |

## Nix Integration

The toolbelt provides a `claude-with-servers` wrapper that:
1. Starts all configured MCP servers
2. Generates a `.mcp.json` merging all server configs
3. Launches `claude` with the generated config
4. Cleans up server processes on exit

See `scripts/claude-with-servers` for the implementation.
