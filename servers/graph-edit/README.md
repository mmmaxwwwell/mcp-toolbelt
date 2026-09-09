# graph-edit (design only)

AST-first code editor. The agent operates on **symbols** (functions, classes,
types, methods) — not files, not text ranges. A stateful session accumulates
graph mutations; `commit` mechanically serializes the mutated graph back to
disk, deciding file layout, import order, and formatting from
`.graph-edit.toml` policy — not from the agent.

## Status

Design only — no implementation yet. This README exists to pressure-test the
concept before building.

**Language backend plan:**
- **TypeScript** — v1 target. Built on [`ts-morph`](https://ts-morph.com/)
  (parses `tsconfig.json`, tracks project-wide symbol graph, serializes back
  with formatting/trivia fidelity).
- **Python** — planned. Backend: [`libcst`](https://libcst.readthedocs.io/)
  (concrete syntax tree — preserves whitespace/comments; the standard for
  refactoring tools).
- **Rust** — planned. Backend: [`syn`](https://docs.rs/syn) for parsing +
  [`prettyplease`](https://docs.rs/prettyplease) for serialization, with
  [`rust-analyzer`'s ide-db](https://github.com/rust-lang/rust-analyzer)
  crates for reference tracking. Alternative: build on top of an rust-analyzer
  daemon via LSP + custom extensions.
- **Others** (Go, Nix, Java) — considered, not scheduled.

Each backend is a separate module; the MCP tool surface is uniform across
languages so the agent doesn't learn per-language APIs.

## Why this, when we already have `edit-surface`?

`edit-surface` is a **text-anchor** editor with tree-sitter validation. It
prevents corruption but the agent still thinks in files and text.

`graph-edit` is **AST-first**. The agent thinks in symbols. File placement,
formatting, and import bookkeeping are the *server's* decisions, driven by
config, not the agent's judgement.

| Concern | `edit-surface` | `graph-edit` |
|---|---|---|
| Agent's mental model | file + text anchor | symbol id in the project graph |
| Edit unit | text range | AST node (function body, param list, decorator, import) |
| File placement | agent chooses | server chooses (from `.graph-edit.toml` rules) |
| Cross-file rename | not supported | atomic — updates definition + every reference on commit |
| Import bookkeeping | agent's job | automatic — added when needed, removed when unused, sorted, deduped |
| Formatting | not applied | mechanical on commit (prettier / black / rustfmt) |
| Validation | tree-sitter re-parse | full type-check via the language's project model (`ts-morph`, `mypy`, `cargo check`) |
| Session model | stateless per call | stateful — accumulate edits, preview, commit or discard |
| Language backends | one (tree-sitter, shared) | one per language (proper AST library) |
| Failure mode | corrupt-syntax edit rejected | invalid-typegraph edit rejected before it leaves memory |

Neither replaces the other outright:
- `edit-surface` stays for languages `graph-edit` doesn't have a backend for,
  and for one-off anchor edits where opening a session is overhead.
- `graph-edit` is the *primary* source-editing path where the backend exists.
  `fs-fallback`'s refusal message points here first, `edit-surface` second.

## Vision — one worked example

Agent brief: "add a `deactivate` method to `UserService` that sets
`active = false` and emits a `user.deactivated` event."

Old workflow (`Read` + `Edit`):
1. Agent globs `**/UserService*`, opens 3 hits, picks one
2. Agent reads the file, finds where methods live, writes a text edit
3. Agent guesses at the import style, may or may not add the event import
4. Agent runs prettier by hand (or forgets)
5. Callers of `emit` are checked... maybe

`graph-edit` workflow:
```jsonc
{ "tool": "list_symbols", "arguments": { "query": "UserService", "kind": "class" } }
// → [ { "id": "sym:src/services/user.ts#UserService", "kind": "class", "signature": "class UserService", "methods": ["activate", "load", "save"] } ]

{ "tool": "get_symbol", "arguments": { "id": "sym:src/services/user.ts#UserService" } }
// → { signature, methods (with their signatures), source_render, references_count }

{ "tool": "add_method", "arguments": {
    "class_id": "sym:src/services/user.ts#UserService",
    "name": "deactivate",
    "signature": "async deactivate(): Promise<void>",
    "body": "this.active = false;\nawait this.eventBus.emit('user.deactivated', { id: this.id });"
  }
}
// server infers: need to import EventBus type if `this.eventBus` isn't already typed,
//   sort methods per policy, resolve `emit` signature via ts-morph, verify body type-checks.

{ "tool": "preview" }
// → unified diff across all touched files (may include automatic import additions in the file)

{ "tool": "commit" }
// → writes file(s), runs prettier, updates code-graph index, returns final diff.
```

The agent never named a file. The agent never touched an import. Formatting
happened mechanically. If `body` doesn't type-check, `commit` refuses with
the tsc error — the AST session was never in a broken state.

## Optimizing for the agent — "get in, get out, don't flail"

The primitive tools (`get_symbol`, `list_symbols`, `add_method`, …) are
necessary but not sufficient. Agents flail on primitives — 6 exploratory
calls to compose what one bundled tool could answer. The tool set below is
organized so that **the most common tasks are the fewest calls**, and every
response carries a little more context than the literal question asked for.

Design rules baked into the surface:

1. **Bundled beats composed.** Every task-shaped tool returns "everything
   you need in one shot" — symbol + callers + tests + related patterns.
   Round-trips cost more than tokens.
2. **Every response includes a `related` field.** 3 things the agent will
   probably want next, precomputed via graph proximity. Cheap to include;
   often eliminates the next call.
3. **Refuse ambiguous, don't dump.** `find(query)` with >20 hits returns a
   preview + `"narrow with kinds= or scope="` — forces constraint instead
   of a token flood.
4. **Cost hints in tool descriptions.** `find(mode:"concept")` says
   "warmer, uses vector index; prefer `mode:"name"` for exact identifiers."
   Agents lean on the fastest path when told which is fastest.
5. **Preview is a health check, not just a diff.** `preview()` returns
   `{ diff, type_check: pass/errors, tests_likely_affected, imports_added,
   imports_removed }`. Agent commits with confidence or `discard`s early.

## Search — three indexes, one query surface

Symbols are heterogeneous. Different queries want different indexes. One
tool, indexed-choice under the hood:

| Index | What it holds | Best for | Backend |
|---|---|---|---|
| **name/signature FTS** | symbol names, param types, return types, member names | `find("handleAuth")`, "any function returning `Promise<User>`" | SQLite FTS5 (BM25) |
| **doc/comment vectors** | jsdoc bodies, `//` comments above symbols, module-top summaries | `find("how does this project handle retries?", mode: "concept")` | Local embedding (see below) |
| **structural** | call edges, type refs, import graph | `find("callers of login", mode: "usage")`, "everything constructing `HttpClient`" | `code-graph` |

**One tool:**

```
find(query, kinds?, scope?, mode?)
  # mode: "name" | "concept" | "usage" | "auto" (default)
  # auto: try FTS first; if <3 hits or low BM25, escalate to vectors; combine
  # scope: module glob or symbol id — restricts search
  # kinds: filter to class/function/interface/…
```

Responses include `hits`, `top: [{ id, kind, name, signature, snippet,
score, source_index }]`, and `related` (nearby symbols the agent will
probably want next).

### The narrow embedding exception

DESIGN.md is FTS5-first for good reasons (deterministic, no cold-start,
no model dep). This server intentionally breaks that rule in exactly one
place:

- **Only index doc comments + module-top summaries** (not bodies, not
  names). Bodies stay pure FTS5.
- **Local model only** — [`all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
  or similar. ~90 MB, CPU-fast (~10 ms/query), packaged via nix.
- **Same SQLite** — vectors stored as blobs; no separate vector DB.
- **Hybrid retrieval** — FTS5 is primary; vectors fill in when BM25 is
  low-confidence or the query is conceptual (matched by heuristic + explicit
  `mode: "concept"`).
- **No SaaS ever** — reproducible builds only. Vector index rebuild on
  first `find(mode: "concept")` call per session.

Where BM25 measurably fails: concept queries with different vocabulary
than the code itself ("throttle" vs "rateLimit" vs "debounce"). That's
the only place this pays off — hence the narrow scope.

## Bundled context tools — "get in, get out"

Instead of the agent composing 6 primitives, the tool bundles the
composition. These are the tools the agent should reach for **first**;
the primitives further below exist for cases these can't cover.

- **`open_symbol(id_or_query)`** — the workhorse read tool. Returns:
  - the symbol (signature + body + doc)
  - top-N callers with 3-line context snippets
  - type dependencies (rendered inline, one hop)
  - sibling exports from the same module
  - related tests (heuristic: `<name>.test.ts` + any test that imports it)
  - `related: [3 nearby symbols by graph proximity]`

  One call → full mental model. Replaces the common `list_symbols` →
  `get_symbol` → `get_references` → read-each round-trip.

- **`explore(intent, target?)`** — task-oriented briefing. `intent: "add
  caching to UserService.load"` returns:
  - the target symbol (if resolvable) with full context
  - existing patterns in the repo matching the intent (concept-search on
    comments + name-search on `cache|memo|remember` in symbols)
  - related infrastructure (imports of `redis`, config files, env-var
    references)
  - relevant tests
  - the file `.graph-edit.toml` would pick for a new symbol matching the
    intent (via `[layout]` rules)
  - `related: [next-hop symbols]`

  Effectively the agent's "briefing" for one focused change. Replaces
  10+ exploratory calls with 1.

- **`describe_change_zone(id)`** — pre-edit blast radius. Returns:
  - every caller of the symbol with the exact line that would break under
    a signature change
  - every type-alias/interface that references it
  - every test that mocks or spies on it
  - every re-export
  - `is_public_api` heuristic (exported from a barrel? Used by external
    modules?)

  Called *before* `edit_symbol_signature` or `delete_symbol` so the agent
  knows what it's committing to. `commit`'s `accept_breaking_callers`
  gate cross-references this response.

- **`similar_to(id, k?)`** — "show me 5 other functions like this."
  Vector-nearest on signature + body embedding + doc. Answers "what
  convention do peers use?" without the agent guessing at grep queries.
  Cheap under the same narrow-embedding index.

- **`session_summary()`** — after several edits, before commit: returns
  the pending diff *plus* the graph-level story ("added `deactivate` on
  `UserService`; touched 3 callers; introduced 1 import; broke 0
  callers"). Lets the agent verify its own work compactly and produce
  its own PR-description-quality summary.

## MCP tool surface (v1 scope, TypeScript)

Tools are grouped by concern. All are project-scoped to the session opened
by first call.

**Preference order:** bundled tools (above) → search (`find`) → primitives
(below). Primitives exist as escape hatches; agents should reach for
`open_symbol` / `explore` first.

### Read

- `list_symbols(query?, kind?, module?)` — filter symbols by name / kind
  (`class` | `function` | `interface` | `type` | `enum` | `variable`) /
  module path. Returns `[{ id, kind, name, module, signature }]`.
- `get_symbol(id)` — full detail. Returns `{ id, kind, name, signature,
  source_render, doc_comment, references_count, defined_in, exports_from }`.
- `get_references(id)` — every call/read site. Returns `[{ file, line,
  context_line, kind: "call" | "type_ref" | "import" | "reexport" }]`.
- `list_modules(pattern?)` — the module graph. Returns `[{ path, exports: [...],
  imports_count }]`.
- `describe_module(path)` — signatures of everything exported from a module,
  plus what it imports.

### Write — structural

- `create_symbol({ kind, name, module?, signature, body?, doc? })` —
  create a new function / class / interface / type. `module` optional:
  if omitted, the file-placement policy decides.
- `add_method({ class_id, name, signature, body, visibility?, static? })`
- `add_property({ class_id, name, type, initializer?, visibility?, readonly? })`
- `edit_symbol_body(id, body)` — replace the body of a function or method.
  Signature untouched.
- `edit_symbol_signature(id, signature)` — change params / return type. Tool
  response includes a `breaking_callers: [{ id, kind_of_break }]` list; the
  agent must call `commit` with `accept_breaking_callers: true` if callers
  will now fail to type-check.
- `rename_symbol(id, new_name)` — updates definition + every reference across
  files. Atomic.
- `move_symbol(id, target_module)` — moves definition, rewrites the source
  file's exports, adds/removes imports at every call site.
- `delete_symbol(id, { refactor_callers? })` — remove definition. If callers
  exist, `refactor_callers` is required and must be one of:
  `"refuse"` (reject the delete) | `"inline_last_use"` (only if exactly one
  caller and its site is a trivial pass-through) | `"leave_broken"` (commit
  anyway; agent takes responsibility).

### Write — supporting

- `add_import({ module_path, imports: [{ name, alias? }] })` — usually
  automatic, but exposed for cases the inferrer can't handle
  (side-effect imports, dynamic imports).
- `add_export(id, { from_module? })` — re-export from another module (barrel
  files).
- `add_decorator(id, decorator_source)`
- `set_doc_comment(id, jsdoc_source)`

### Session

- `preview()` — health-check + diff. Returns:
  - `diff` — cross-file unified diff of pending changes
  - `type_check` — `pass` or `[{ file, line, message }]` from `tsc --noEmit`
    against the in-memory session
  - `formatter` — `applied` (prettier ran in-memory so the diff matches
    what commit will produce)
  - `imports_added`, `imports_removed`
  - `tests_likely_affected` — heuristic: tests whose files import a
    changed symbol
  - `breaking_callers` — carried over from prior structural edits
- `commit({ accept_breaking_callers? })` — write to disk, run prettier,
  update the `code-graph` index. Returns:
  - `diff` — final applied diff
  - `intent_recap` — one-paragraph summary the agent can quote back
    ("added `deactivate` method to `UserService`; wired `eventBus` import;
    exported from module")
  - `files_written`, `files_deleted`
  Refuses if `preview()` type-check fails unless `accept_breaking_callers`
  is passed AND the failures are limited to the explicit `breaking_callers`
  list from a prior `edit_symbol_signature` / `delete_symbol` call.
- `discard()` — drop pending edits, keep the session open.
- `reset_session()` — re-parse from disk (useful if another process edited files).
- `session_summary()` — see bundled tools above.

### Response envelopes

Every read tool returns `{ ...result, related: [ ... ] }`. `related` is
3 symbols the agent will probably want next, ranked by:
1. Graph proximity (called-by / calls, type-refs)
2. Same-module siblings
3. Same-directory tests

`find` and search tools also return a `next_calls` field with 1-3
suggested follow-up tool invocations (e.g. `{ tool: "open_symbol", args:
{ id: "sym:..." } }`) — the agent can execute or ignore.

Every mutating tool returns `{ ...result, warnings: [...] }` when the
change has non-fatal concerns (unused import created, doc comment on a
now-different-shaped signature is stale, symbol matches a naming
convention but was placed against a `[layout]` rule).

## Session model

- **One session per project root**, keyed by the directory containing
  `.graph-edit.toml` (or `tsconfig.json` if unconfigured — see fallback below).
- Session is created lazily on first tool call and cached in-process.
- Session state is a `ts-morph` `Project` instance + a "pending mutations"
  overlay. `commit` flushes the overlay to disk.
- Sessions don't persist across server restarts. Agent restart → fresh parse.
  Full re-parse of a mid-sized TS project takes 500ms–3s; acceptable per
  session.

Concurrency: **one active mutation at a time per session**. Reads are safe;
writes take a lock. Two agents sharing a session is out of scope for v1
(there's no MCP "session" concept — the server holds it per project).

## Serialization policy — `.graph-edit.toml`

The file that turns "add a method" into "write to *this* file with *these*
imports in *this* order."

```toml
[project]
tsconfig = "tsconfig.json"           # required for TS backend
root_dir = "src"                     # where symbols live

[layout]
one_class_per_file = true            # class Foo → src/**/foo.ts
one_component_per_file = true        # React FC → matches [layout.components] rules
function_grouping = "topic"          # "topic" | "one_per_file" | "keep_existing"

[layout.components]
pattern = "^[A-Z][a-zA-Z]*$"         # PascalCase named exports of JSX
target_dir = "src/components/"
naming = "kebab-case"                # UserCard → user-card.tsx

[layout.hooks]
pattern = "^use[A-Z]"
target_dir = "src/hooks/"

[layout.services]
pattern = "Service$"
target_dir = "src/services/"

[imports]
sort_order = ["node", "external", "absolute", "relative"]
absolute_prefix = "@/"               # matches tsconfig paths
merge_duplicates = true
remove_unused = true                 # on every commit

[naming]
functions = "camelCase"
classes = "PascalCase"
types = "PascalCase"
constants = "SCREAMING_SNAKE_CASE"   # top-level const with primitive initializer
enums = "PascalCase"
enum_members = "PascalCase"

[reexports]
barrel_files = "auto"                # "auto" | "manual" | "none"
# "auto": maintain src/*/index.ts to re-export public symbols in that folder
public_marker = "@public"            # jsdoc tag; symbols without it stay module-private

[formatter]
command = "prettier"                 # or "biome format"
args = ["--write"]
skip_if_missing = false              # error out if formatter not on PATH

[type_check]
strict = true                        # commit refuses on any tsc error
```

**Precedence when `move_symbol` or `create_symbol` picks a file:**
1. Explicit `module` arg on the tool call
2. Matching `[layout.<group>]` rule (first match wins)
3. Existing file for that symbol (for edits, not creates)
4. `[project] root_dir` + `<kebab-name>.ts` as a last resort

If none of these produce a decision the server can defend, `create_symbol`
refuses with `"file placement ambiguous — add a [layout] rule or pass module="` .

## Composition with the rest of the toolbelt

- **`code-graph`** — canonical source of the symbol graph. `graph-edit`
  reads from it to resolve symbol IDs and reference lists; writes back to
  it on `commit` (or triggers a re-index). Both must agree.
- **`edit-surface`** — fallback for languages `graph-edit` doesn't back yet,
  and for one-off edits where opening a session is overhead. `fs-fallback`'s
  refusal message becomes: *"source-code writes go through `graph-edit`
  (preferred) or `edit-surface` (fallback for anchor-based edits)."*
- **`fs-fallback`** — refuses source files entirely if `graph-edit` has a
  backend for that language. Non-source files (configs, docs, lockfiles)
  still go through `fs-fallback`.
- **`nix-dev-exec`** — used internally: `commit` invokes the formatter and
  `preview_types` invokes `tsc --noEmit` through it, so the same bwrap sandbox
  the rest of the toolbelt uses covers `graph-edit`'s tool invocations.
- **`test-runner`** — natural next step after `commit`: agent runs relevant
  tests to verify the edit worked. Not orchestrated by `graph-edit` itself.
- **`nix-mcp-proxy`** (eventually) — per-project policy layer: some agents
  or environments may deny `delete_symbol` or `edit_symbol_signature`
  entirely.

## Language backend status

| Language | Backend | Status | Notes |
|---|---|---|---|
| TypeScript / TSX / JS / JSX | `ts-morph` | **v1 target** | Best ecosystem; ts-morph is battle-tested, supports the full type checker, mutations, and serialization with trivia fidelity |
| Python | `libcst` | Planned | Concrete syntax tree preserves whitespace/comments. Instagram uses it for repo-wide refactoring at scale. |
| Rust | `syn` + `prettyplease` + rust-analyzer ide-db | Planned | Reference tracking is the hard part — `syn` alone doesn't do it. Options: (a) call `rust-analyzer` as a daemon, (b) build our own resolver on top of `ide-db` crates. Likely (a). |
| Go | `go/ast` + `go/format` | Considered | Go's toolchain has strong AST support; deferred pending demand. |
| Nix | `rnix-parser` | Considered | Would give `graph-edit` for our own flake evolution; low priority. |

Each backend implements a small `Backend` trait / interface (parse project,
resolve symbol id, get references, apply mutation, serialize). The MCP tool
handlers are language-agnostic; they dispatch to whichever backend claims
the file extension.

## Open design questions

- **Session scope across projects.** One agent may work in a monorepo with
  multiple `tsconfig.json` roots. One session per tsconfig, or one per
  monorepo root? Leaning: one per tsconfig, with a `switch_session(root)`
  tool.
- **Symbol id stability.** `sym:src/services/user.ts#UserService` breaks when
  the file moves. `move_symbol` transparently updates all callers, but the
  agent may still be holding the old id in its prompt. Options: (a) accept
  the churn and rely on the agent to re-list, (b) include a stable content
  hash in the id.
- **Read rendering.** `get_symbol` returns `source_render` — but rendered
  how? Formatted per project style? With/without doc comments? Compact
  (signature only) vs full body? Probably a `render_style` parameter on
  the tool.
- **Overloads and generics.** TypeScript overloads → multiple declarations
  for one symbol id? Or one symbol id per overload? Same for Rust `impl`
  blocks split across files.
- **Comments and trivia.** A `create_symbol` doesn't take doc comments in
  the signature — separate `set_doc_comment`. But what about inline
  comments in the body? Passed verbatim in `body` and preserved by the
  serializer? Yes.
- **Barrel files.** `[reexports].barrel_files = "auto"` is powerful but can
  produce enormous diffs. Needs a preview-time warning: "this commit will
  regenerate 12 index.ts files."
- **Escape hatch.** Sometimes the AST really doesn't match what the agent
  wants (e.g. macro-generated code, decorator meta-programming). Do we
  offer a `raw_edit_symbol(id, new_source)` that bypasses the AST layer
  but still runs through the formatter + type check? Probably yes — the
  agent needs an out or it'll fall back to `fs-fallback` and lose all the
  organization guarantees.
- **Prior art we should study.** [`ts-morph` examples](https://ts-morph.com/manipulation/),
  [Meta's Codemod](https://github.com/facebookincubator/Codemod),
  [`jscodeshift`](https://github.com/facebook/jscodeshift),
  [`libcst` codemods](https://libcst.readthedocs.io/en/latest/codemods.html),
  Instagram's `libcst`-powered `Refactor` at scale, [Sourcegraph Batch
  Changes](https://sourcegraph.com/docs/batch-changes) (structural search),
  JetBrains SSR. None ship as an MCP.

## Why not just extend `edit-surface`?

Considered. Rejected because:

- `edit-surface`'s upstream (`jbr/semantic-edit-mcp`) is a text-anchor tool
  with tree-sitter validation. Its architecture doesn't have a symbol graph,
  a project session, or a type checker.
- Wrapping it with a graph layer means we implement the graph logic anyway,
  and only save the write-to-disk step.
- Per-language backends need real AST libraries (`ts-morph`, `libcst`, `syn`),
  not tree-sitter grammars. Tree-sitter is a parser, not a type-aware
  refactoring engine.

Sibling, not successor. Both stay in the catalog.

## Why not just use LSP via `jonrad/lsp-mcp`?

Considered. LSP gives us rename / find-refs / diagnostics for free, but:

- LSP protocol assumes an editor-driven interaction model (hover, completion,
  code-action-at-cursor). AST-first *creation* — "add a method with this
  signature and body" — isn't in LSP. We'd wrap LSP with our own tools
  anyway.
- LSP doesn't own file layout. It refactors within existing structure; it
  doesn't decide "this new component goes in `src/components/UserCard/`
  and index.ts gets an export line."
- Running an LSP per language per project is heavy compared to an in-process
  `ts-morph` `Project`.

We may still call into a language server for reference tracking (the hardest
part in Rust), but the top-level tool surface is ours, not LSP's.

## Roadmap sketch (non-binding)

1. TypeScript backend, v1 tool surface, `.graph-edit.toml` v1, session
   model, prettier integration, type-check gate on commit.
2. Integration with `code-graph` — mutations trigger re-index of only the
   touched files.
3. Python backend on `libcst`, same tool surface.
4. Rust backend on rust-analyzer daemon + `syn`/`prettyplease` fallback.
5. `.graph-edit.toml` policy expansions as real projects reveal what's
   missing.
6. Escape hatch tool (`raw_edit_symbol`) if the AST-only surface proves
   too rigid in practice.
