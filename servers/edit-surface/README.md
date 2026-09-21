# edit-surface

Nix packaging for [`jbr/semantic-edit-mcp`](https://github.com/jbr/semantic-edit-mcp)
(pinned to tag `v0.2.1`) — a Model Context Protocol server for AST-aware
code editing using tree-sitter.

> **Note**: The spec references the fork at
> [`metaphorics/mcp-contexual-code-edit`](https://github.com/metaphorics/mcp-contexual-code-edit)
> (note the typo "contexual"). That fork is behind upstream (only v0.1.2)
> and has no additional value. We pin to the canonical upstream
> [`jbr/semantic-edit-mcp`](https://github.com/jbr/semantic-edit-mcp)
> which is actively maintained and published to
> [crates.io](https://crates.io/crates/semantic-edit-mcp).

## Upstream research

| Field | Value |
|---|---|
| Crate | [`semantic-edit-mcp`](https://crates.io/crates/semantic-edit-mcp) |
| Version | **0.2.1** (tag `v0.2.1`, commit `7af1a1c`, 2025-07-29) |
| Repository | [jbr/semantic-edit-mcp](https://github.com/jbr/semantic-edit-mcp) |
| License | MIT OR Apache-2.0 |
| Language | Rust (edition 2024, requires rustc 1.85+) |
| Build system | Cargo (`Cargo.lock` present on tagged releases) |
| Entry point | `semantic-edit-mcp` binary (from `src/main.rs`) |
| Stdio mode | Default — running the bare binary with no subcommand starts the MCP stdio server |
| MCP SDK | `mcplease 0.2.3` (lightweight MCP server crate) |

### Cargo dependencies

**Runtime (from `Cargo.toml` at v0.2.1):**

| Package | Version | Purpose |
|---|---|---|
| mcplease | 0.2.3 | MCP protocol handling |
| clap | 4.5 | CLI argument parsing |
| serde | 1.0 | Serialization |
| serde_json | 1.0 | JSON handling |
| tokio | 1.45 | Async runtime |
| anyhow | 1.0 | Error handling |
| tree-sitter | 0.25 | AST parsing core |
| tree-sitter-rust | 0.24 | Rust grammar |
| tree-sitter-javascript | — | JavaScript grammar |
| tree-sitter-typescript | — | TypeScript grammar |
| tree-sitter-python | — | Python grammar |
| tree-sitter-json | — | JSON grammar |
| walkdir | 2.5 | Directory traversal |
| ropey | 1.6 | Rope-based text editing |
| diffy | — | Diff generation |

### MCP tools

v0.2.1 exposes a small stage/preview/persist workflow. All editing tools take
an `operation` (`insert_after`, `insert_before`, or `replace`) plus an
`anchor` — a short, distinctive text snippet that uniquely identifies the
AST node to target.

| Tool | Description |
|---|---|
| `preview_edit` | Stage an operation and return a diff preview of the changes (no write) |
| `retarget_edit` | Change the anchor/operation of the currently staged edit without rewriting the content |
| `persist_edit` | Commit the currently staged operation to disk |
| `set_working_directory` | Set the session's working root so subsequent edits can use relative paths |

**Operations:**

- `insert_after` — insert content after the complete AST node containing the anchor
- `insert_before` — insert content before the complete AST node containing the anchor
- `replace` — replace the entire AST node that starts with the anchor text

To remove code, use `replace` with empty content.

### Anchors

Nodes are targeted by anchor text — no line/column, no tree-sitter queries in the
public tool surface. Guidelines from the upstream CLI help:

- Keep anchors short but unique (e.g. `fn main`, `struct User`, `import React`)
- Anchors are whitespace-insensitive
- If an anchor matches multiple sites, the server picks the best placement

### Environment variables

| Variable | Purpose |
|---|---|
| `MCP_SESSION_STORAGE_PATH` | Override session storage path (default: `~/.ai-tools/sessions/semantic-edit.json`) |

### Language support

v0.2.1 supports Rust, JavaScript, TypeScript, Python, JSON, and TOML via
tree-sitter grammar crates. The architecture is extensible — additional
languages require adding the tree-sitter grammar dependency and a parser module.

## Packaging notes

- Written in Rust — use `buildRustPackage` with `fetchFromGitHub`.
- **Published to crates.io** as `semantic-edit-mcp`, but use `fetchFromGitHub`
  for the `Cargo.lock` and full source tree.
- Pin to tag `v0.2.1` (commit `7af1a1c`, 2025-07-29). `Cargo.lock` is present
  on tagged releases.
- Rust edition 2024 requires nixpkgs Rust ≥ 1.85. Nixpkgs unstable should
  have this.
- Tree-sitter grammars are pure Rust crates (no native C compilation needed
  for the grammars since tree-sitter 0.25 uses Rust bindings).
- Binary name for `meta.mainProgram`: `semantic-edit-mcp`.
- No special flags for MCP stdio mode — just run the binary directly.

## Standalone use

```nix
{
  inputs.edit-surface.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/edit-surface";

  outputs = { self, nixpkgs, flake-utils, edit-surface }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in
      {
        devShells.default = pkgs.mkShell {
          packages = [ edit-surface.packages.${system}.default ];
        };
      });
}
```

## Composition

The `edit-surface` slot provides AST-aware code editing operations via
tree-sitter. The server validates syntax before and after edits, preventing
file corruption. Pairs with `code-graph` (read-only navigation via
tree-sitter) and `test-runner` (run tests to verify edits).
