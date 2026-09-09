---
name: graph-edit
description: Use for any source-code change in a graph-edit-supported language (TypeScript v1; Python + Rust planned). Symbols, not files. Bundled tools over primitives. Always preview-then-commit. Refuse-friendly — read the warning fields, use the related field, and trust the file-placement policy.
---

# Using graph-edit

**graph-edit is an AST-first source editor.** You operate on *symbols* —
functions, classes, methods, types — not on files or text ranges. The server
decides file placement, import order, and formatting from
`.graph-edit.toml`. Your job is to describe *what* the code should be; the
server figures out *where and how* to write it.

## When to use graph-edit

**Use it for**: any source-code change in a language the server backs
(TypeScript / TSX / JS / JSX in v1; Python + Rust when their backends land).

**Don't use it for**:
- Config files, docs, lockfiles, non-code text → `fs-fallback`
- Source files in unsupported languages → `edit-surface` (anchor-based fallback)
- Reading code without editing → `code-graph` or `codebase` are cheaper

**Never do**: raw string-edit source files via `fs-fallback`. That server
will refuse and point you here.

## The one rule

> **Prefer bundled tools over primitives.**
> `open_symbol` over (`list_symbols` + `get_symbol` + `get_references`).
> `explore` over browsing.
> `describe_change_zone` before any signature change.

Every response has a `related` field with 3 suggested next symbols and a
`next_calls` field with 1-3 suggested tool invocations. Read them. They
exist to save you a round trip.

## Recipes for common tasks

### "Add a method to a class"

```jsonc
1. open_symbol("UserService")
   // Returns class + existing methods + callers + tests + related.
   // You now know the naming convention, error style, and test layout.

2. add_method({
     class_id: "sym:src/services/user.ts#UserService",
     name: "deactivate",
     signature: "async deactivate(): Promise<void>",
     body: "this.active = false;\nawait this.eventBus.emit('user.deactivated', { id: this.id });"
   })
   // Server auto-adds imports if needed; may return warnings.

3. preview()
   // Read diff + type_check + tests_likely_affected. If type_check has errors, fix and preview again.

4. commit()
   // Returns intent_recap you can quote back in your response to the user.
```

### "Rename a function across the codebase"

```jsonc
1. describe_change_zone("sym:src/auth/login.ts#login")
   // See how many callers exist, whether it's a public API, which tests mock it.
   // If is_public_api = true and you weren't expecting that, STOP and confirm with user.

2. rename_symbol({ id: "sym:...#login", new_name: "signIn" })

3. commit()
   // All 27 call sites updated, all imports rewritten, all tests renamed if they reference by name.
```

### "Understand a codebase before editing"

```jsonc
1. explore({ intent: "add rate limiting to the public API" })
   // Returns: relevant symbols (existing rate limiters if any), patterns
   // (which decorators/middleware the project uses), tests, config, and
   // where a new rate-limit adapter should live per .graph-edit.toml.

2. // now you have a full briefing. Proceed to the actual edit with confidence.
```

### "Find code by concept, not name"

```jsonc
1. find({ query: "how does this project handle transient failures?", mode: "concept" })
   // Vector-backed search over doc comments + module summaries.
   // Finds retry/backoff/circuit-breaker code even if the names are unfamiliar.

// vs.

1. find({ query: "retryWithBackoff", mode: "name" })
   // FTS5 lookup — instant, exact identifier match.
```

### "Change a function's signature"

```jsonc
1. describe_change_zone("sym:src/api/parseRequest.ts#parseRequest")
   // See every caller with the exact line that will break.

2. edit_symbol_signature({
     id: "sym:...#parseRequest",
     signature: "async parseRequest(input: string, options: ParseOptions): Promise<Request>"
   })
   // Response includes breaking_callers: [...]

3. preview()
   // type_check will fail — that's expected. Confirm the failures match breaking_callers.

4. commit({ accept_breaking_callers: true })
   // OR: fix each caller with edit_symbol_body first, then commit without the flag.
```

### "Move a symbol to a different module"

```jsonc
1. move_symbol({ id: "sym:src/utils/helpers.ts#formatDate", target_module: "src/date/format.ts" })
   // Definition moves. All imports across the codebase rewrite to the new path.

2. preview()
3. commit()
```

### "Delete unused code"

```jsonc
1. describe_change_zone("sym:src/legacy/oldApi.ts#deprecated")
   // If callers exist, the tool call below will refuse without a policy.

2. delete_symbol({ id: "sym:...#deprecated", refactor_callers: "refuse" })
   // If no callers: deleted. If callers: response tells you to use
   // "inline_last_use" (only if 1 trivial caller) or "leave_broken"
   // (agent takes responsibility). Prefer "refuse" and fix callers first.

3. commit()
```

## Search modes — which to use

| Mode | Use when | Cost | Example |
|---|---|---|---|
| `name` | You know the identifier or a prefix | fastest (FTS5) | `find("handleAuth", mode: "name")` |
| `concept` | You know the *idea*, not the words used in code | ~10 ms + one-time index warm | `find("caching layer", mode: "concept")` |
| `usage` | You want callers / constructors / references | graph query | `find("users of HttpClient", mode: "usage")` |
| `auto` | You don't know which — let the server pick | tries name first, escalates | `find("throttle requests")` |

Default is `auto`. Reach for explicit modes only when auto is picking wrong.

## When `commit` refuses

`commit` is the safety gate. It refuses when:

- **Type errors** — the pending session doesn't type-check.
  → Fix the errors (usually `edit_symbol_body` on the changed symbol or
  its callers), `preview()` again, then `commit()`.
  → If the errors are the intentional consequence of an
  `edit_symbol_signature` / `delete_symbol`, pass `accept_breaking_callers:
  true` — but only if the failing symbols match the `breaking_callers`
  list from that prior call.

- **File placement ambiguous** — you called `create_symbol` without
  `module` and no `[layout]` rule matches.
  → Either add a `[layout]` rule (via `fs-fallback` on `.graph-edit.toml`)
  or pass `module` explicitly.

- **Formatter missing** — `prettier` (or configured formatter) not on PATH.
  → Not your problem to fix in-session; report to user.

- **Naming convention violation** — created a symbol whose name doesn't
  match the pattern for its inferred location.
  → Rename or pass an explicit `module` that has different naming rules.

## Anti-patterns — don't do these

- ❌ **Grabbing primitives when a bundled tool covers your task.**
  Three calls (`list_symbols` → `get_symbol` → `get_references`) when
  `open_symbol` returns all three plus tests plus related. Total token
  cost of primitives is usually higher despite each call being smaller.

- ❌ **Guessing at `module` when creating a symbol.** Don't. Let the
  policy pick. Pass `module` only when the policy refuses (ambiguous).

- ❌ **Skipping `describe_change_zone` before signature changes.** You'll
  hit `commit` refusal and waste calls debugging what broke.

- ❌ **Committing without `preview`.** Preview is cheap and includes
  type-check + test-likelihood. Not previewing is how you commit type
  errors and get bounced back.

- ❌ **Ignoring `warnings` in response envelopes.** They flag drift
  (stale doc comment, unused import auto-added, layout rule bypassed).
  Cheap to address in-session; expensive to catch later.

- ❌ **Ignoring `related` and `next_calls`.** They're precomputed context.
  If `related` includes the tests for the symbol you just opened, you
  don't need to search for them.

- ❌ **Long-running sessions across unrelated changes.** Sessions cache
  the ts-morph project state; if you switch tasks, `reset_session()`
  to drop stale mutations. Otherwise you may accidentally commit
  work-in-progress from a prior task.

## Response envelope reference

Every read response:
```jsonc
{
  ...tool-specific fields,
  "related": [
    { "id": "sym:...", "kind": "function", "reason": "called by target" },
    ...
  ],
  "next_calls": [
    { "tool": "open_symbol", "args": { "id": "sym:..." } }
  ]
}
```

Every mutating response:
```jsonc
{
  ...tool-specific fields,
  "warnings": [
    { "kind": "unused_import", "message": "..." },
    ...
  ]
}
```

`preview` response:
```jsonc
{
  "diff": "...unified diff...",
  "type_check": "pass" | [{ "file", "line", "message" }],
  "formatter": "applied",
  "imports_added": [...],
  "imports_removed": [...],
  "tests_likely_affected": [...],
  "breaking_callers": [...]  // from prior structural edits
}
```

`commit` response:
```jsonc
{
  "diff": "...final diff...",
  "intent_recap": "one-paragraph summary quotable back to the user",
  "files_written": [...],
  "files_deleted": [...],
  "warnings": [...]
}
```

## Session hygiene

- Session opens lazily on first tool call. Nothing to do to start it.
- One session per project root (dir with `.graph-edit.toml` or
  `tsconfig.json`).
- `discard()` drops pending mutations, keeps session (fast).
- `reset_session()` re-parses from disk (use when another process edited files).
- Sessions don't persist across server restart — next call will re-parse.

## Composition with other servers

- **`code-graph`** is the read-side of the same graph. Cheap for
  navigation; use for questions that don't need mutation.
- **`fs-fallback`** for configs, docs, lockfiles, non-code text. Its
  refusal on source files points here.
- **`edit-surface`** for languages graph-edit doesn't back (Go, Nix,
  arbitrary tree-sitter langs). Anchor-based, cheaper for one-off tweaks.
- **`nix-dev-exec`** runs the formatter (`prettier`, `black`, `rustfmt`)
  and type-checker (`tsc`, `mypy`, `cargo check`) under bwrap. You don't
  invoke it directly — `preview` and `commit` route through it.
- **`test-runner`** is the natural next call after `commit`: run the
  tests in `tests_likely_affected` from the `preview` response.

## Escape hatches

- **`raw_edit_symbol(id, new_source)`** — if the AST tools can't express
  what you need (macro-generated code, decorator meta-programming), bypass
  the structural layer. Formatter + type-check still run. Use rarely —
  every use erodes the "server owns organization" guarantee.
- **Passing explicit `module` on `create_symbol`** — overrides layout
  policy. Use when the policy really doesn't have a rule for your case;
  consider adding a `[layout]` rule so the next agent doesn't have to.
