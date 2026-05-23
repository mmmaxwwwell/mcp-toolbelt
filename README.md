# mcp-toolbelt

A Nix flake that bundles MCP servers useful to coding agents. Drop it into your
project's `flake.nix`, toggle on the servers you want, and your devshell starts
them automatically.

Every server is itself a flake under [`servers/<name>/`](servers/), so you can
also consume them one at a time without going through the root.

## What's in here

| Server | Status | What it does |
|--------|--------|--------------|
| [`code-graph`](servers/code-graph/) | working | Wraps [`code-review-graph`](https://github.com/tirth8205/code-review-graph) — a persistent, incrementally updated knowledge graph of your codebase, exposed over MCP. The agent calls `get_minimal_context_tool`, `query_graph_tool`, `semantic_search_nodes_tool`, etc. to navigate and reason about code without re-reading whole files every turn. TypeScript-first via tree-sitter. |
| [`nix-mcp-proxy`](servers/nix-mcp-proxy/) | placeholder | A typed, sealed, middleware-driven MCP proxy that sits between agents and upstream MCP servers, enforcing a whitelist of allowed tools / paths / fields. Lives at [mmmaxwwwell/nix-mcp-proxy](https://github.com/mmmaxwwwell/nix-mcp-proxy); the slot here will become a passthrough once that repo ships a buildable package. |
| [`docs-fetcher`](servers/docs-fetcher/) | design only | Downloads version-pinned documentation for every tool/dependency your project actually uses, then exposes it over MCP so the agent looks up the *right* docs instead of guessing from training data. |

## Quick start

In your project's `flake.nix`:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    mcp-toolbelt.url = "github:mmmaxwwwell/mcp-toolbelt";
  };

  outputs = { self, nixpkgs, flake-utils, mcp-toolbelt }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        toolbelt = mcp-toolbelt.lib.${system}.mkShellHook {
          projectName = "my-app";
          servers = {
            codeGraph = {
              enable = true;
              watch = true;
              # Things the upstream DEFAULT_IGNORE_PATTERNS doesn't already cover.
              excludeDirs = [ "fixtures" "vendor-snapshots" ];
            };
          };
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [ mcp-toolbelt.packages.${system}.code-review-graph ];
          shellHook = toolbelt;
        };
      });
}
```

`nix develop` will then:
1. Merge `code-review-graph` into your `.mcp.json` (preserving other servers).
2. Install the upstream Claude Code skill files into `.claude/skills/`.
3. Register a `PostToolUse` hook so the graph updates after every Edit/Write/Bash.
4. Start a filesystem watcher so the graph stays fresh between turns.

## Per-server options

The full set of options each server accepts is documented in its own README:

- [`servers/code-graph/`](servers/code-graph/) — passes options straight through to [`code-review-graph`'s `mkShellHook`](servers/code-graph/flake.nix), including `watch`, `serveMcp`, `autoInstall`, `mcpPort`, `stateDir`, `excludeDirs`.

## Consuming a single server

If you only want one server, skip the root flake and reference it directly:

```nix
inputs.code-graph.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/code-graph";
```

This is also how the toolbelt itself composes them — each server flake is
independent, with its own `flake.lock`.

## Why a collection?

Coding agents benefit from a small, opinionated set of MCP servers that
mechanically pre-process the project before each LLM turn — graph-backed code
navigation, version-pinned doc lookup, an editing surface that knows the
project's structure. The toolbelt is a place to assemble those servers under
one Nix entry point so any new project can opt in with a few lines of flake
config rather than re-wiring each tool by hand.

## License

MIT.
