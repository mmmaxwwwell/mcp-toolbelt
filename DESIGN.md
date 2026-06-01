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
| `WebFetch` | `web-browser` (fetcher-mcp + FTS5 sidecar) | Playwright + Readability + Turndown extraction; every fetch is also indexed into a user-global SQLite FTS5 store so the agent can `search_cached(query)` across every page ever fetched. |
| `WebSearch` | `web-search` (pskill9/web-search) | DuckDuckGo-backed search, no API key required. Tavily/Exa are documented opt-in upgrades. |
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

#### `web-browser` — Sidecar over fetcher-mcp with FTS5 cross-page search
- **Upstream:** [jae-jae/fetcher-mcp](https://github.com/jae-jae/fetcher-mcp) (TypeScript, MIT)
- **Shape:** Sidecar MCP server. Our server speaks MCP to the agent and spawns `fetcher-mcp` as a child process over stdio. We pass `fetch_url`-style calls through, then on success we write the extracted markdown to a SQLite FTS5 store before returning the result to the agent. Upstream stays untouched — free upgrades when `fetcher-mcp` releases.
- **What it does:** Playwright headless browser renders pages with full JS (covers modern SPA docs), then Mozilla's Readability + Turndown extracts clean markdown. Every successful fetch is indexed into FTS5 so the agent can later search across every page it's ever fetched.
- **Storage:** User-global SQLite database at `~/.cache/mcp-toolbelt/web-cache.db` with FTS5 + WAL mode. One index shared across all projects on the machine — bigger corpus to search at the cost of cross-project bleed (acceptable: it's docs from the public web, not project source).
- **Schema:** `pages(id, url UNIQUE, title, fetched_at, markdown)` + `pages_fts USING fts5(title, markdown, content='pages')`. URL is the natural key; second fetch of the same URL replaces the row (URLs evolve, the freshest copy wins).
- **Replaces:** `WebFetch` — agent gets pre-digested markdown plus cross-page search, not HTML soup re-fetched every turn.
- **Added tools on top of fetcher-mcp:**
  - `search_cached(query, limit?)` — FTS5 BM25 search; returns `[{url, title, fetched_at, snippet}]`
  - `get_cached(url)` — full markdown from cache, no network
  - `list_cached(filter?)` — enumerate URLs with title + fetched_at; agent can ask "what have I been reading?"
  - `purge_cached(url?)` — drop a stale row when an upstream doc page changed
- **Composition note:** The FTS5 store is logically a subset of what `sqlite-store` would manage. When `sqlite-store` is built, `web-browser` may migrate to writing into its `web.*` namespace instead of owning a private DB. Until then the private DB keeps `web-browser` self-contained.
- **Disqualified alternatives:**
  - `mcp-read-website-fast`: lighter (no Chromium) but no JS rendering, so SPA docs return garbage. Modern API references (Stripe, Vercel, etc.) need Playwright.
  - Firecrawl/Tavily/Exa: paid API keys, wrong default for a flake collection.
  - Microsoft `playwright-mcp`: returns verbose accessibility trees, designed for browser automation not doc reading.

#### `web-search` — Free web search
- **Upstream:** [pskill9/web-search](https://github.com/pskill9/web-search) (TypeScript, MIT)
- **What it does:** DuckDuckGo-backed search, returns ranked result list with titles + snippets + URLs. No API key required.
- **Replaces:** `WebSearch` — orthogonal to `web-browser`; search to discover URLs, fetch+extract to read them.
- **Opt-in upgrades:** Users who bring their own API key can swap in `tavily-ai/tavily-mcp` or `exa-labs/exa-mcp-server` for higher-quality semantic search. Document both in `servers/web-search/README.md`.

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
