# mcp-toolbelt

Replace Claude Code's built-in tools with MCP servers that mechanically
pre-process inputs and outputs — adding structure, caching, security scoping,
and token efficiency. The agent stops reading raw files, running raw shell
commands, and parsing raw HTML. Instead it calls high-level MCP tools that
return pre-digested, policy-compliant results.

## Quick start

```bash
# From any project directory:
nix run github:mmmaxwwwell/mcp-toolbelt -- "implement the auth module"
```

This runs `claude-with-servers`, which auto-detects available MCP server
binaries on PATH, generates a merged `.mcp.json`, and launches Claude Code
with all servers configured.

## What replaces what

| Built-in Tool | MCP Server | Approach |
|---|---|---|
| `Edit`, `Write` (source code) | **[edit-surface](servers/edit-surface/)** | Graph-routed structured ops (`edit_function_body`, `rename_symbol`, `move_symbol`). Per-language backends: `ts-morph` (TS), `libcst` (Python), `go/ast` (Go), `rnix-parser` (Nix). Syntactically valid by construction. |
| `Read`, `Write` (non-code) | **[fs-fallback](servers/fs-fallback/)** | ACL-gated raw read/write for configs, docs, lockfiles, and unsupported languages. Discouraged for source code — descriptions steer the agent to `edit-surface` first. |
| `Bash` | **[nix-dev-exec](servers/nix-dev-exec/)** | Registry of named operations defined in `.nix-dev-exec.toml`. Every call expands to `nix develop -c "<command>"`. No free-form shell, no chaining. |
| `Bash (pnpm)` | **[pnpm-wrapper](servers/pnpm-wrapper/)** | Fixed verbs (`add`, `test`, `run`, `lint`). Structured output. No `dlx` / `exec` / `--global`. Lockfile-aware. |
| `Read`, `Glob`, `Grep` | **[code-graph](servers/code-graph/)** | Persistent incremental knowledge graph. The agent navigates symbols, not files. Wraps [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph). |
| `WebFetch` | **[web-browser](servers/web-browser/)** | Sidecar around [jae-jae/fetcher-mcp](https://github.com/jae-jae/fetcher-mcp): Playwright + Readability + Turndown for full JS rendering, with every extracted page written to a user-global SQLite FTS5 index at `~/.cache/mcp-toolbelt/web-cache.db`. Adds `search_cached`, `get_cached`, `list_cached`, `purge_cached` on top of the upstream fetch tool. |
| `WebSearch` | **[web-search](servers/web-search/)** | DuckDuckGo-backed search, no API key required. Wraps [pskill9/web-search](https://github.com/pskill9/web-search). Tavily/Exa are documented opt-in upgrades for users who bring a key. |
| *(none yet)* | **[nix-mcp-proxy](servers/nix-mcp-proxy/)** | Tool/path/field whitelisting + validation, implemented upstream; no wrapper sits behind it yet. Audit logging and rate limiting are not built (would be custom middleware on top of the built-in error-mapping/size-limit/validation). |
| *(versioned docs)* | **[docs-fetcher](servers/docs-fetcher/)** | Downloads docs pinned to each dependency's resolved version. Stops the agent from inventing APIs based on training-data versions. |

## Server catalog

| Server | Status | Slot |
|--------|--------|------|
| [`code-graph`](servers/code-graph/) | working | Persistent knowledge graph of your codebase |
| [`codebase`](servers/codebase/) | packaged | Tree-sitter-based code intelligence via [tree-sitter-mcp](https://github.com/nicobailon/tree-sitter-mcp) |
| [`nix-mcp-proxy`](servers/nix-mcp-proxy/) | implemented upstream, not packaged here | Sealed allowlist/validator proxy (`mkProxy`); `broker-secrets` branch adds `${SECRET:}` credential injection + streamable-HTTP upstreams. No slot `flake.nix` yet |
| [`edit-surface`](servers/edit-surface/) | packaged | Anchor-based code editing with tree-sitter validation via [jbr/semantic-edit-mcp](https://github.com/jbr/semantic-edit-mcp) |
| [`graph-edit`](servers/graph-edit/) | packaged | AST-first source-code editing via ts-morph. Symbols not files. Stateful session + policy-driven serialization per `.graph-edit.toml`. TypeScript v1; Python (`libcst`) + Rust (`syn` + rust-analyzer) planned |
| [`fs-fallback`](servers/fs-fallback/) | packaged | ACL-gated raw read/write for non-code files; soft-delete trash, audit log, `edit-surface` refusal hints |
| [`pnpm-wrapper`](servers/pnpm-wrapper/) | packaged | Fixed-verb pnpm wrapper with structured output. Every invocation sandboxed via bubblewrap |
| [`nix-dev-exec`](servers/nix-dev-exec/) | packaged | Registered operations run inside `nix develop -c`, wrapped in bubblewrap |
| [`docs-fetcher`](servers/docs-fetcher/) | packaged | Reads manifests (npm/cargo/pypi) + fetches per-version docs into a tagged SQLite FTS5 index. Search by `tech`, `package`, `version` |
| [`github-api`](servers/github-api/) | packaged | Official [github/github-mcp-server](https://github.com/github/github-mcp-server) — issues, PRs, code search, releases across 21 toolsets |
| [`web-browser`](servers/web-browser/) | packaged | Sidecar wrapping [fetcher-mcp](https://github.com/jae-jae/fetcher-mcp); writes extracted markdown to a user-global SQLite FTS5 index for cross-page search |
| [`web-search`](servers/web-search/) | packaged | DuckDuckGo search via [pskill9/web-search](https://github.com/pskill9/web-search); Tavily/Exa opt-in |
| [`git-guard`](servers/git-guard/) | packaged | Scoped, audited git operations |
| [`test-runner`](servers/test-runner/) | packaged | Structured test execution |
| [`sqlite-store`](servers/sqlite-store/) | packaged | Shared FTS5 storage backend |
| [`task-runner`](servers/task-runner/) | packaged | Shell command execution via [shell-mcp](https://github.com/devrelopers/shell-mcp) |

See [`DESIGN.md`](DESIGN.md) for the full architecture, token efficiency
strategy, and storage design.

## Using in your project

### Option 1: `claude-with-servers` command

Add to your project's `flake.nix`:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    mcp-toolbelt.url = "github:mmmaxwwwell/mcp-toolbelt";
  };

  outputs = { self, nixpkgs, flake-utils, mcp-toolbelt }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            mcp-toolbelt.packages.${system}.claude-with-servers
            mcp-toolbelt.packages.${system}.code-review-graph
            # Add other server packages as they become available
          ];
        };
      });
}
```

Then: `nix develop` → `claude-with-servers`

### Option 2: `mkShellHook` (code-graph only, for now)

```nix
shellHook = mcp-toolbelt.lib.${system}.mkShellHook {
  projectName = "my-app";
  servers = {
    codeGraph = {
      enable = true;
      watch = true;
      excludeDirs = [ "fixtures" "vendor-snapshots" ];
    };
  };
};
```

### Disabling specific servers

Set environment variables before running `claude-with-servers`:

```bash
MCP_TOOLBELT_WEB_BROWSER=0 claude-with-servers  # skip mcp-read-website-fast
MCP_TOOLBELT_WEB_SEARCH=0 claude-with-servers   # skip pskill9/web-search
MCP_TOOLBELT_GIT=0 claude-with-servers           # skip mcp-server-git
```

## Consuming a single server

```nix
inputs.code-graph.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/code-graph";
```

Each server is an independent flake with its own `flake.lock`.

## License

MIT.
