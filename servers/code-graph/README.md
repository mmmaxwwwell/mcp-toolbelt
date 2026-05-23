# code-graph

Nix packaging for [`code-review-graph`](https://github.com/tirth8205/code-review-graph)
(MIT, pinned to v2.3.2) — a persistent, incrementally updated knowledge graph
of your codebase, exposed over MCP so a coding agent can navigate and reason
about code without re-reading whole files every turn.

This is a vendored copy of the same flake the
[`spec-kit`](https://github.com/mmmaxwwwell/agent-framework/tree/main/.claude/skills/spec-kit)
skill ships, lifted out so any project can consume it without depending on the
agent-framework checkout.

## What you get

- A `code-review-graph` Python application built from upstream's tagged release.
- A reusable `mkShellHook` that, on `nix develop`, will:
  1. Merge `code-review-graph` into the project's `.mcp.json` (preserving other servers).
  2. Install the upstream Claude Code skill files into `.claude/skills/`.
  3. Register a `PostToolUse` hook that runs `update` after every Edit/Write/Bash.
  4. Start a filesystem watcher so the graph stays fresh between agent turns.
  5. Optionally start a long-running MCP server (`code-review-graph serve`).

## MCP tools the agent gets

The full catalog is fetched lazily via `get_docs_section_tool(section_name="commands")`,
but the most useful entry points are:

- `get_minimal_context_tool(task="…")` — ~100 tokens; decides which subsequent tool to use.
- `detect_changes_tool(detail_level="minimal")` — risk-scored impact of the current diff.
- `get_review_context_tool(base="main")` — blast radius + source snippets.
- `query_graph_tool(pattern="callers_of", target="foo")` — symbol-specific graph walks.
- `semantic_search_nodes_tool(query="rate limiter")` — find things by meaning.

## Standalone use

```nix
{
  inputs.code-graph.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/code-graph";

  outputs = { self, nixpkgs, flake-utils, code-graph }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in
      {
        devShells.default = pkgs.mkShell {
          packages = [ code-graph.packages.${system}.code-review-graph ];
          shellHook = code-graph.lib.${system}.mkShellHook {
            projectName = "my-app";
            watch = true;
          };
        };
      });
}
```

## Bumping the upstream version

Edit `version` and `hash` in [`flake.nix`](flake.nix); both must move together.
The install hook auto-reruns on version bumps because the marker file name
embeds the version.
