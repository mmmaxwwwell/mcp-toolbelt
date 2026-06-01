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
| Stdio mode | Default — no special flags needed (optional `serve` subcommand also works) |
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

**Core editing (AST-aware):**

| Tool | Description |
|---|---|
| `replace_node` | Replace an entire AST node with new content |
| `insert_before_node` | Insert content before a node |
| `insert_after_node` | Insert content after a node |
| `wrap_node` | Wrap an existing node with new syntax |

**Specialized insertion (Rust-specific):**

| Tool | Description |
|---|---|
| `insert_after_struct` | Insert after struct definitions |
| `insert_after_enum` | Insert after enum declarations |
| `insert_after_impl` | Insert after impl blocks |
| `insert_after_function` | Insert after function definitions |
| `insert_in_module` | Smart module-level positioning |

**Utility:**

| Tool | Description |
|---|---|
| `validate_syntax` | Check code validity (file or inline) |
| `get_node_info` | Get AST node info at a location |

All operations support `preview_only: true` for dry-run mode.

### Node selectors

Nodes can be targeted by:
- **Position** — line and column
- **Name + type** — e.g., struct named `Foo`
- **Type only** — e.g., all `impl` blocks
- **Tree-sitter query** — arbitrary pattern matching

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
