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
| *(all servers)* | **[nix-mcp-proxy](servers/nix-mcp-proxy/)** | Tool/path/field whitelisting, rate limiting, audit logging. Every wrapper sits behind it. |
| *(versioned docs)* | **[docs-fetcher](servers/docs-fetcher/)** | Downloads docs pinned to each dependency's resolved version. Stops the agent from inventing APIs based on training-data versions. |

## Server catalog

| Server | Status | Slot |
|--------|--------|------|
| [`code-graph`](servers/code-graph/) | working | Persistent knowledge graph of your codebase |
| [`nix-mcp-proxy`](servers/nix-mcp-proxy/) | in development | Proxy middleware for all servers |
| [`edit-surface`](servers/edit-surface/) | design only | Graph-routed structured edits (TS/Python/Go/Nix) |
| [`fs-fallback`](servers/fs-fallback/) | design only | ACL-gated raw read/write for non-code files |
| [`pnpm-wrapper`](servers/pnpm-wrapper/) | design only | Fixed-verb pnpm wrapper with structured output |
| [`nix-dev-exec`](servers/nix-dev-exec/) | design only | Registered operations run inside `nix develop -c` |
| [`docs-fetcher`](servers/docs-fetcher/) | design only | Version-pinned dependency documentation |
| `web-browser` | planned | Token-efficient web browsing |
| `git-guard` | planned | Scoped, audited git operations |
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
