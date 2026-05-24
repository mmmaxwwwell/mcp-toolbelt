# edit-surface (design only)

Graph-routed structured edits as the **primary** code-editing surface. The
agent doesn't see file paths and content — it sees symbols and operations.
The server reserializes from AST after each edit, guaranteeing syntactic
validity by construction.

## Status

Design only — no implementation yet. This README locks the *shape* (per-language
backends, op surface, return contract) so the eventual implementation doesn't
drift toward "AST-validated string edits at file paths" (which is a 60%
solution but a one-way door for the API).

## Why graph-routed instead of file-path edits

| Problem with file/string edits | How structured ops fix it |
|---|---|
| Agent corrupts syntax (mismatched braces, broken JSX) | Server reserializes from AST; invalid edits rejected before write |
| Agent re-reads 800-line files to change 3 lines | `get_function_body(symbol)` returns ~30 tokens; `edit_function_body(symbol, new_body)` writes back |
| Rename misses one call site, breaks build | `rename_symbol` walks every reference in the graph atomically |
| Imports drift (unused, missing, wrong path) | `add_import` / `remove_unused_imports` are first-class ops |
| Agent invents methods that already exist | `list_methods(class)` is cheap; agent checks before adding |

## Per-language backend strategy

One MCP server, one op surface, multiple backends. The agent calls
`edit_function_body(symbol="src/auth.ts:login", body="…")` and the server
routes to the right backend based on the file's language.

| Language | Backend | Capabilities |
|---|---|---|
| TypeScript / JavaScript | [`ts-morph`](https://ts-morph.com/) (TS Compiler API wrapper) | Full structural ops — rename across project, move, extract, import management, JSX |
| Python | [`libcst`](https://github.com/Instagram/LibCST) | Concrete syntax tree preserves whitespace/comments; round-trip safe |
| Go | `go/ast` + `go/parser` + `gofmt` (invoked via `nix-dev-exec`) | Native toolchain produces canonical output |
| Nix | [`rnix-parser`](https://github.com/nix-community/rnix-parser) | Lossless CST for the Nix language |
| Rust *(future)* | `syn` + `rustfmt` | After v0.3 |
| (anything else) | not supported — falls through to [`fs-fallback`](../fs-fallback/) with a warning in the tool response |

Tree-sitter is **not** used here — it's read-only for navigation in
[`code-graph`](../code-graph/). edit-surface needs semantic resolution
(rename across files, type-aware moves), which tree-sitter alone can't give.

## MCP tool surface (planned)

All tools take **symbol references**, not file paths. A symbol reference is
`<path>:<qualified-name>` or a graph node id from `code-graph`.

### Read

- `get_symbol(ref)` — source + location + immediate context (callers, callees, type)
- `get_function_body(ref)` — body only, no signature noise
- `list_methods(class_ref)` — what's already on this class
- `list_imports(file_ref)` — what's imported, by what name, used where
- `find_symbol_by_name(name, kind?)` — disambiguation for the agent

### Write

- `edit_function_body(ref, new_body)` — replace body, signature unchanged
- `replace_symbol(ref, new_source)` — replace full definition (signature + body)
- `rename_symbol(ref, new_name)` — atomic across all references
- `move_symbol(ref, target_file)` — moves definition, updates all imports
- `add_method(class_ref, source)` — append a method to a class
- `add_import(file_ref, module, names)` — adds or merges with existing import
- `remove_unused_imports(file_ref)`
- `extract_function(file_ref, start, end, new_name)` — refactoring primitive

### Inspect

- `dry_run(op)` — returns the diff that *would* be applied, plus list of
  files touched, without writing
- `which_backend(file_ref)` — what backend would handle this file

## Return contract

Every write op returns:

```json
{
  "ok": true,
  "files_changed": ["src/auth.ts", "src/api/handlers.ts"],
  "symbols_affected": ["login", "loginHandler"],
  "context": "<minimal post-edit context slice — callers, tests covering it>",
  "warnings": ["…"]
}
```

The `context` field is the key efficiency win: the agent gets the post-edit
graph slice for free, so it doesn't need a follow-up `get_review_context_tool`
call to decide what to do next.

## Briefing pattern

Every tool's `description` field is a guaranteed-read briefing slot. Pattern:

> **What this does.** One sentence.
> **When to use.** vs. `fs-fallback.write` and similar.
> **Invariant.** What the server guarantees you don't have to verify.

A top-level `start_session(task)` tool returns the project's invariants —
language conventions, what's allowlisted, what's behind `fs-fallback`, the
agent's mission — every turn. The skill enforces calling it first.

## Composition

This server sits behind [`nix-mcp-proxy`](../nix-mcp-proxy/), which enforces
the project's per-symbol / per-path allowlist. The server itself trusts its
inputs; the proxy is the policy layer.

## Open design questions

- **Cross-file atomicity.** `rename_symbol` touches N files. If one write
  fails midway, do we rollback (transaction log) or report partial-failure?
- **Concurrent edits.** Agent + human editor on the same file. Lock?
  Detect-and-reject? Three-way merge?
- **Generated code.** `*.gen.ts`, protobuf output, schema-generated types
  — refuse edits and direct to the generator's source?
- **Comments and whitespace.** ts-morph and libcst differ on round-trip
  preservation. Need a consistent stance across backends.
- **Formatter integration.** Always run prettier/black/gofmt/nixpkgs-fmt
  after each edit, or expose `format_file(ref)` as a separate op?
