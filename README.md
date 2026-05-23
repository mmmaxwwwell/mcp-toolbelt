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

| Built-in Tool | MCP Server | Upstream |
|---|---|---|
| `Read`, `Glob`, `Grep` | **codebase** | [nendotools/tree-sitter-mcp](https://github.com/nendotools/tree-sitter-mcp) — AST-enriched search, symbol outlines, usage tracing across 15+ languages |
| `Edit`, `Write` | **edit-surface** | [metaphorics/mcp-contextual-code-edit](https://github.com/metaphorics/mcp-contexual-code-edit) — tree-sitter validated edits that prevent syntax corruption |
| `Bash` | **task-runner** | [devrelopers/shell-mcp](https://github.com/devrelopers/shell-mcp) — per-directory `.shell-mcp.toml` allowlists, no arbitrary shell |
| `Bash (git)` | **git-guard** | [mcp-server-git](https://pypi.org/project/mcp-server-git/) — scoped repos/branches/paths, contributor identity, audit log |
| `Bash (git)` | **github-api** | [github/github-mcp-server](https://github.com/github/github-mcp-server) — issues, PRs, code search via GitHub API |
| `WebFetch`, `WebSearch` | **web-browser** | [jae-jae/fetcher-mcp](https://github.com/jae-jae/fetcher-mcp) — Playwright + Readability extraction, token-efficient |
| *(deep code understanding)* | **code-graph** | [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph) — persistent incremental knowledge graph |
| *(test execution)* | **test-runner** | [privsim/mcp-test-runner](https://github.com/privsim/mcp-test-runner) — structured results across Jest/Pytest/Go/Rust |
| *(shared storage)* | **sqlite-store** | [RMANOV/sqlite-memory-mcp](https://github.com/RMANOV/sqlite-memory-mcp) — FTS5 + WAL, caches browsed content and search indexes |
| *(all servers)* | **nix-mcp-proxy** | [mmmaxwwwell/nix-mcp-proxy](https://github.com/mmmaxwwwell/nix-mcp-proxy) — tool whitelisting, rate limiting, audit logging |

## Server catalog

| Server | Status | Slot |
|--------|--------|------|
| [`code-graph`](servers/code-graph/) | working | Persistent knowledge graph of your codebase |
| [`nix-mcp-proxy`](servers/nix-mcp-proxy/) | in development | Proxy middleware for all servers |
| [`docs-fetcher`](servers/docs-fetcher/) | design only | Version-pinned dependency documentation |
| `codebase` | planned | Tree-sitter semantic code search |
| `edit-surface` | planned | AST-aware code editing |
| `web-browser` | planned | Token-efficient web browsing |
| `git-guard` | planned | Scoped, audited git operations |
| `task-runner` | planned | Whitelisted shell commands |
| `test-runner` | planned | Structured test execution |
| `sqlite-store` | planned | Shared FTS5 storage backend |

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
MCP_TOOLBELT_WEB_BROWSER=0 claude-with-servers  # skip fetcher-mcp
MCP_TOOLBELT_GIT=0 claude-with-servers           # skip mcp-server-git
```

## Consuming a single server

```nix
inputs.code-graph.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/code-graph";
```

Each server is an independent flake with its own `flake.lock`.

## License

MIT.
