# graph-edit — Implementation Mega-Prompt

Paste this document (or reference it by path) to a Claude Code session with:

> Work through `servers/graph-edit/IMPLEMENTATION-MEGAPROMPT.md` phase by
> phase. Complete each phase's verification before starting the next.
> Dispatch parallel subagents for phases marked "parallel." Report at
> each phase gate.

The document is a **build orchestration script**, not just prompts. It
encodes:
- Sequencing (what must complete before what)
- Parallelization boundaries (which agents can run at the same time)
- Interface contracts (locked in Phase 0 so parallel agents don't drift)
- Verification gates between phases

## Prerequisites — read these before starting

1. `servers/graph-edit/README.md` — full design doc
2. `servers/graph-edit/SKILL.md` — agent-facing usage guide (behavior the
   implementation must produce)
3. `servers/web-browser/sidecar/{package.json,tsconfig.json,src/index.ts,src/db.ts}`
   — reference for TypeScript Node MCP server layout
4. `servers/nix-dev-exec/flake.nix` and `servers/nix-dev-exec/server/src/index.ts`
   — reference for buildNpmPackage + MCP tool registration
5. `servers/fs-fallback/server/src/policy.ts` — reference for TOML config
   parsing pattern
6. `DESIGN.md` — architecture constraints (FTS5 default, shared SQLite,
   `~/.cache/mcp-toolbelt/`, bwrap sandboxing)
7. `tests/lib.sh` + `tests/scenarios/end-to-end.sh` — test harness the
   graph-edit server plugs into

## What we're building

A stateful, project-scoped MCP server that offers AST-first source-code
editing via `ts-morph` for TypeScript (v1 scope). Sessions hold an
in-memory `ts-morph` Project + a pending-mutations overlay. `commit`
mechanically serializes the mutated graph back to disk under
`.graph-edit.toml` policy (file placement, imports, formatting).

Tool surface (v1, ~32 tools) is documented in
`servers/graph-edit/README.md`. **Do not add tools not in the design doc.
Do not omit tools that are in the design doc.**

## Scope constraints

- **TypeScript only for v1.** Backend interface must be language-agnostic
  (so Python/Rust can slot in later), but only implement the TS backend.
- **No embedding index in v1.** `find(mode: "concept")` returns a
  clean "not-implemented-in-v1" error; `mode: "name"` and `mode: "usage"`
  work. Concept mode is Phase 5, deferred.
- **Reuse existing infrastructure.** SQLite via `better-sqlite3` (same as
  web-browser/fs-fallback). Config parsing via `@iarna/toml` (same as
  nix-dev-exec/pnpm-wrapper).
- **No new upstream deps beyond ts-morph + prettier.** Do NOT reach for
  frameworks (nest, express, etc.) — this is a stdio MCP server.
- **No native compilation beyond better-sqlite3.** Keep the build simple.

## Overall phase plan

```
Phase 0 — Foundation (serial, 1 agent)                       ← interface lock
Phase 1 — Read primitives (parallel, 3 agents)
Phase 2 — Write primitives — structural (parallel, 4 agents)
Phase 3 — Session mgmt + policy (parallel, 2 agents)
Phase 4 — Bundled context tools (parallel, 3 agents)
Phase 5 — Search: name + usage modes (parallel, 2 agents)     ← concept mode deferred
Phase 6 — Integration + tests (parallel, 3 agents)
Phase 7 — Ecosystem wiring (serial, 1 agent)
```

Each phase's "AGENT PROMPT" section is what to paste into a subagent's
`prompt` field. Everything above it (Goal / Deliverables / Verification)
is context for you, the orchestrator, to read and cross-check.

---

# Phase 0 — Foundation (serial, 1 agent)

## Goal
Lock the interfaces every subsequent parallel agent will implement against.
When this phase completes, subsequent agents can work in disjoint files
without stepping on each other because all shared types + traits + tool
registration are already defined.

## Deliverables

Directory layout under `servers/graph-edit/`:
```
flake.nix
server/
  package.json
  package-lock.json
  tsconfig.json
  src/
    index.ts               # MCP server entry, tool registry wiring
    types.ts               # ALL shared types — the interface lock
    backend.ts             # Backend interface (language-agnostic)
    session.ts             # Session class skeleton (method signatures only)
    policy.ts              # .graph-edit.toml loader (parses to typed config)
    discover.ts            # Walk up to find .graph-edit.toml or tsconfig.json
    tools/
      registry.ts          # MCP tool registry: name → { schema, handler }
      _stubs.ts            # Stub handlers for every design-doc tool
    backends/
      ts-morph.ts          # TS backend skeleton (implements Backend, throws NotImplemented)
.graph-edit.toml.example
README.md                  # already exists — do NOT rewrite
SKILL.md                   # already exists — do NOT rewrite
```

`server/src/types.ts` must export **every** interface subsequent phases
depend on. This is the lock — no additions after Phase 0 without an
explicit interface amendment ticket. Minimum contents:

```typescript
// Identity
export type SymbolId = string;  // "sym:<project-relative-path>#<qualified-name>"
export type ModulePath = string;  // project-relative "src/foo/bar.ts"
export type ProjectRoot = string;  // absolute path

// Symbol kinds (aligned with ts-morph SyntaxKind but backend-agnostic)
export type SymbolKind =
  | "class" | "function" | "interface" | "type" | "enum"
  | "variable" | "method" | "property" | "namespace";

// Read-side records
export interface SymbolRecord {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  module: ModulePath;
  signature: string;
  doc?: string;
  is_exported: boolean;
  visibility?: "public" | "private" | "protected";
}

export interface SymbolDetail extends SymbolRecord {
  source_render: string;      // formatted source of the symbol
  body?: string;              // just the body (for functions/methods)
  references_count: number;
  defined_in: ModulePath;
  members?: SymbolRecord[];   // for classes/interfaces/enums
}

export interface Reference {
  file: ModulePath;
  line: number;
  column: number;
  context_line: string;
  kind: "call" | "type_ref" | "import" | "reexport" | "extends" | "implements";
}

// Response envelopes — universal across read tools
export interface RelatedItem {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  reason: string;  // "called by target" | "same module sibling" | ...
}

export interface NextCall {
  tool: string;
  args: Record<string, unknown>;
  rationale: string;
}

export interface ReadResponse<T> {
  data: T;
  related: RelatedItem[];
  next_calls: NextCall[];
}

// Mutation response
export interface Warning {
  kind: "unused_import" | "stale_doc" | "layout_bypass" | "naming_convention" | string;
  message: string;
  symbol_id?: SymbolId;
}

export interface MutationResponse<T = { mutation_id: string }> {
  data: T;
  warnings: Warning[];
}

// Session-level records
export interface BreakingCaller {
  caller_id: SymbolId;
  file: ModulePath;
  line: number;
  kind_of_break: "signature_arity" | "return_type" | "removed_symbol" | "renamed_symbol" | string;
  message: string;
}

export interface PendingMutation {
  id: string;                // uuid
  kind: string;              // tool name that produced it
  target?: SymbolId;
  breaking_callers?: BreakingCaller[];
  raw_ops: unknown;          // backend-specific op record
}

// Preview shape
export interface PreviewResult {
  diff: string;
  type_check: "pass" | Array<{ file: ModulePath; line: number; message: string }>;
  formatter: "applied" | "skipped_missing" | "skipped_error";
  imports_added: Array<{ module: ModulePath; source: string }>;
  imports_removed: Array<{ module: ModulePath; source: string }>;
  tests_likely_affected: ModulePath[];
  breaking_callers: BreakingCaller[];
}

// Commit shape
export interface CommitResult {
  diff: string;
  intent_recap: string;
  files_written: ModulePath[];
  files_deleted: ModulePath[];
  warnings: Warning[];
}

// Policy config (from .graph-edit.toml — see README for full example)
export interface PolicyConfig {
  project: { tsconfig: string; root_dir: string };
  layout: {
    one_class_per_file?: boolean;
    one_component_per_file?: boolean;
    function_grouping?: "topic" | "one_per_file" | "keep_existing";
    groups: Array<{ name: string; pattern: string; target_dir: string; naming?: string }>;
  };
  imports: { sort_order: string[]; absolute_prefix?: string; merge_duplicates: boolean; remove_unused: boolean };
  naming: Record<string, string>;
  reexports: { barrel_files: "auto" | "manual" | "none"; public_marker: string };
  formatter: { command: string; args: string[]; skip_if_missing: boolean };
  type_check: { strict: boolean };
}

// Backend interface (implemented per language)
export interface Backend {
  name: string;
  extensions: string[];  // [".ts", ".tsx", ".js", ".jsx"] for ts-morph

  load(root: ProjectRoot, policy: PolicyConfig): Promise<void>;
  reload(): Promise<void>;

  // Read
  listSymbols(query?: string, kinds?: SymbolKind[], scope?: string): Promise<SymbolRecord[]>;
  getSymbol(id: SymbolId): Promise<SymbolDetail>;
  getReferences(id: SymbolId): Promise<Reference[]>;
  listModules(pattern?: string): Promise<Array<{ path: ModulePath; exports: string[]; imports_count: number }>>;
  describeModule(path: ModulePath): Promise<{ exports: SymbolRecord[]; imports: Array<{ module: ModulePath; symbols: string[] }> }>;

  // Write (return PendingMutation, don't touch disk)
  createSymbol(args: unknown): Promise<PendingMutation>;
  addMethod(args: unknown): Promise<PendingMutation>;
  addProperty(args: unknown): Promise<PendingMutation>;
  editSymbolBody(id: SymbolId, body: string): Promise<PendingMutation>;
  editSymbolSignature(id: SymbolId, signature: string): Promise<PendingMutation>;
  renameSymbol(id: SymbolId, newName: string): Promise<PendingMutation>;
  moveSymbol(id: SymbolId, target: ModulePath): Promise<PendingMutation>;
  deleteSymbol(id: SymbolId, refactorCallers: "refuse" | "inline_last_use" | "leave_broken"): Promise<PendingMutation>;
  addImport(args: unknown): Promise<PendingMutation>;
  addExport(args: unknown): Promise<PendingMutation>;
  addDecorator(id: SymbolId, source: string): Promise<PendingMutation>;
  setDocComment(id: SymbolId, source: string): Promise<PendingMutation>;

  // Session
  preview(): Promise<PreviewResult>;
  previewTypes(): Promise<PreviewResult["type_check"]>;
  commit(acceptBreakingCallers: boolean): Promise<CommitResult>;
  discard(): void;

  // Bundled (delegated to backend for language-specific enrichment)
  openSymbol(idOrQuery: string): Promise<unknown>;  // shape defined in Phase 4
  describeChangeZone(id: SymbolId): Promise<unknown>;
  similarTo(id: SymbolId, k?: number): Promise<unknown>;
}
```

`server/src/session.ts` must export a `Session` class whose method
signatures match the tool surface — but every method throws
`NotImplementedError("<tool-name>")`. Later phases replace throws with
real implementations. The Session composes a `Backend`.

`server/src/tools/registry.ts` must map every tool name from
`servers/graph-edit/README.md` (all ~32) to a `{ inputSchema, handler }`
entry. Handlers initially call `session.<method>` which throws
NotImplemented. This registers everything so `tools/list` returns the
complete surface from day one — subsequent agents fill in behavior
without touching the registry.

Every tool schema in the registry must have:
- `name`: kebab-case matching README
- `description`: one-line pulled from README, including cost/mode hints
  where the README has them
- `inputSchema`: JSON Schema Draft 07, one object per tool arg

## Nix flake requirements

`servers/graph-edit/flake.nix` mirrors the shape of
`servers/nix-dev-exec/flake.nix`:
- `buildNpmPackage` with `npmDepsHash`
- Native inputs for `better-sqlite3` (python3, pkg-config, nodejs)
- `symlinkJoin` + `wrapProgram` to put `prettier` and `nodejs` on PATH
  (used by policy formatter step)
- Package name: `graph-edit`. Main program: `graph-edit`.
- Meta: MIT (or whatever the design doc says; check).

## `server/package.json` deps
```json
{
  "@modelcontextprotocol/sdk": "^1.12.0",
  "better-sqlite3": "^11.8.1",
  "@iarna/toml": "^2.2.5",
  "ts-morph": "^24.0.0",
  "micromatch": "^4.0.5",
  "diff": "^5.2.0"
}
```
Dev deps: `@types/node`, `@types/better-sqlite3`, `@types/micromatch`,
`@types/diff`, `typescript`. Node ≥22. `type: "module"`. `bin:
{ "graph-edit": "dist/index.js" }`. Build script: `tsc`.

## Verification for Phase 0
1. `cd servers/graph-edit/server && npm install && npm run build` — passes typecheck.
2. `cd servers/graph-edit && nix build 2>&1 | tail -30` — succeeds after
   patching `npmDepsHash` (use `prefetch-npm-deps` from nixpkgs or extract
   from the failing hash message).
3. `./result/bin/graph-edit < /dev/null` — starts, exits clean on stdin close.
4. Send `initialize` + `tools/list` via `tests/lib.sh` helpers — every
   design-doc tool present in the returned list.
5. Send `tools/call` for `open_symbol` with any args — returns a
   well-formed MCP error whose message contains `NotImplemented`.

## AGENT PROMPT — Phase 0

```
You are creating the foundation for the graph-edit MCP server at
`/home/max/git/mcp-toolbelt/servers/graph-edit/`. This is the interface-lock
phase: all shared types, the Backend trait, the Session skeleton, and the
tool registry must be complete so subsequent parallel agents can implement
tools in disjoint files without contract drift.

## Read first
1. /home/max/git/mcp-toolbelt/servers/graph-edit/README.md
2. /home/max/git/mcp-toolbelt/servers/graph-edit/SKILL.md
3. /home/max/git/mcp-toolbelt/servers/graph-edit/IMPLEMENTATION-MEGAPROMPT.md (this doc — read Phase 0 section fully)
4. /home/max/git/mcp-toolbelt/servers/nix-dev-exec/flake.nix + server/src/index.ts (reference pattern)
5. /home/max/git/mcp-toolbelt/servers/web-browser/sidecar/{package.json,tsconfig.json,src/db.ts}
6. /home/max/git/mcp-toolbelt/servers/fs-fallback/server/src/policy.ts (reference TOML loader)

## Deliverables
See the "Phase 0 — Foundation" section of IMPLEMENTATION-MEGAPROMPT.md for
the exact file list, the required contents of `types.ts` (verbatim
interface signatures), the Backend trait, the Session skeleton, and the
tool registry expectations.

## Critical requirements
- `types.ts` must be complete — every interface subsequent phases reference.
  Copy the type definitions from the megaprompt verbatim; do not simplify.
- Tool registry must include ALL ~32 tools from README.md, with correct
  JSON Schema inputSchemas and descriptions pulled from README language.
- Handlers throw `NotImplementedError("<tool-name>")` — do NOT implement
  behavior. Behavior comes in Phases 1-5.
- Backend interface is language-agnostic. The `ts-morph.ts` backend
  skeleton implements every method but throws NotImplemented.
- .graph-edit.toml.example must match the README's config example.

## Verification (do all of these before reporting done)
1. `cd server && npm install && npm run build` — typecheck passes with 0 errors
2. `cd .. && nix build 2>&1 | tail -30` — patch npmDepsHash from the failure, retry until built
3. `./result/bin/graph-edit < /dev/null` — starts, exits 0 on stdin close
4. Send initialize + tools/list; verify tool count = 32 (or the exact count from README); verify every tool from README present
5. Call any tool; expect MCP error with "NotImplemented" in the message

## Constraints
- Do NOT implement tool behavior (throw NotImplemented)
- Do NOT modify root flake.nix or root README.md
- Do NOT touch anything outside servers/graph-edit/
- Copy interfaces from megaprompt verbatim — do not "simplify"

## Report back
- Files created (list)
- Nix build outcome + final npmDepsHash
- Tool count returned by tools/list
- Any interface additions/deletions from the megaprompt spec (with rationale)
- Anything ambiguous in README/SKILL that needs resolution before Phase 1
```

## Phase 0 gate before moving on
- Verify build passes
- Verify tools/list count matches design doc
- Review the agent's report for interface additions — if any, decide whether to update this megaprompt before Phase 1

---

# Phase 1 — Read primitives (parallel, 3 agents)

## Goal
Every read-side tool works end-to-end against a real TypeScript project.
No writes yet.

## Parallelization
Three agents work on disjoint tool files. All read the same Backend
interface locked in Phase 0. Each replaces the NotImplemented throws in
their assigned tool files AND in the corresponding `ts-morph.ts` backend
methods.

**Coordination note**: All three agents modify `server/src/backends/ts-morph.ts`
(different methods). Have them work sequentially on that file OR split
`ts-morph.ts` into per-concern modules (`ts-morph-read.ts`,
`ts-morph-write.ts`, `ts-morph-session.ts`) at Phase 0 to keep parallel
work clean. **Prefer the split** — instruct Phase 0 agent to do this.

## Agent assignments

### Agent 1A — Symbol listing + retrieval
Files:
- `server/src/tools/list-symbols.ts`
- `server/src/tools/get-symbol.ts`
- `server/src/tools/list-modules.ts`
- `server/src/tools/describe-module.ts`
- Corresponding methods in `server/src/backends/ts-morph-read.ts`:
  `listSymbols`, `getSymbol`, `listModules`, `describeModule`

### Agent 1B — References
Files:
- `server/src/tools/get-references.ts`
- `getReferences` in `ts-morph-read.ts`
- Include the `related` field population helper (`server/src/related.ts`)
  since Agent 1A and 1C both need it — 1B has the lightest tool load,
  gives it the shared util

### Agent 1C — Search (name + usage modes only)
Files:
- `server/src/tools/find.ts`
- `server/src/search/name-search.ts` (FTS5-lite using `micromatch` +
  substring first; SQLite FTS5 index can wait since name search is fast
  in-memory for reasonable project sizes)
- `server/src/search/usage-search.ts` (delegates to `ts-morph`'s reference
  APIs)
- `find(mode: "concept")` returns `{ error: "concept mode not implemented in v1" }`

## Verification for Phase 1
- Fixture: `tests/fixtures/graph-edit-sample/` (create in Phase 6, or
  temporarily use the existing `tests/fixtures/sample-project/` extended
  with more symbols)
- `open_symbol` still throws NotImplemented (Phase 4)
- `list_symbols("UserService")` returns the class record
- `get_symbol(id)` returns full detail including members list
- `get_references(id)` returns call sites with correct line numbers
- `find("Service", mode: "name")` returns hits
- `find(mode: "concept")` returns the deferred error
- `list_modules()` enumerates every module
- All responses include `related` and `next_calls` fields

## AGENT PROMPT — Phase 1, Agent 1A

```
You are implementing the symbol-listing tools for graph-edit at
`/home/max/git/mcp-toolbelt/servers/graph-edit/`. Phase 0 is complete —
all interfaces are locked in server/src/types.ts and every tool is
registered with NotImplemented handlers. Your job: implement 4 tools by
replacing the NotImplemented throws.

## Read first
1. /home/max/git/mcp-toolbelt/servers/graph-edit/IMPLEMENTATION-MEGAPROMPT.md (Phase 1 section)
2. /home/max/git/mcp-toolbelt/servers/graph-edit/README.md (tool surface)
3. /home/max/git/mcp-toolbelt/servers/graph-edit/server/src/types.ts (locked interfaces)
4. /home/max/git/mcp-toolbelt/servers/graph-edit/server/src/backends/ts-morph-read.ts (skeleton)
5. https://ts-morph.com/manipulation/ (ts-morph docs — reference navigation)

## Deliverables
- server/src/tools/list-symbols.ts — handler for list_symbols(query?, kinds?, scope?)
- server/src/tools/get-symbol.ts — handler for get_symbol(id)
- server/src/tools/list-modules.ts — handler for list_modules(pattern?)
- server/src/tools/describe-module.ts — handler for describe_module(path)
- Implementations of the corresponding methods in ts-morph-read.ts:
  listSymbols, getSymbol, listModules, describeModule

## Requirements
- Every response wraps its result in ReadResponse<T> per types.ts
- Populate `related` using server/src/related.ts (Agent 1B is building it —
  if not present, temporarily return []; will be filled in). Coordinate:
  wait for 1B's related.ts before final commit if concurrent.
- Populate `next_calls` with 1-3 sensible follow-ups (e.g., after
  list_symbols suggest get_symbol for the top hit; after describe_module
  suggest open_symbol for the most-referenced export)
- ts-morph SyntaxKind → your SymbolKind: map ClassDeclaration → "class",
  FunctionDeclaration → "function", InterfaceDeclaration → "interface",
  TypeAliasDeclaration → "type", EnumDeclaration → "enum",
  VariableStatement → "variable", MethodDeclaration → "method",
  PropertyDeclaration → "property", ModuleDeclaration → "namespace"
- SymbolId format: "sym:<project-relative-path>#<qualifiedName>" where
  qualifiedName for methods is "ClassName.methodName", for others just the name

## Verification
1. `cd server && npm run build` — 0 errors
2. `cd .. && nix build` — passes
3. Manual smoke: write a small ts-morph project to /tmp, send list_symbols
   request via echo | ./result/bin/graph-edit, verify response
4. Every response has `related` and `next_calls` keys (may be empty arrays
   for `related` if 1B hasn't landed yet)

## Constraints
- Do NOT implement write-side methods (Phase 2 owns them)
- Do NOT implement get_references, find (Agents 1B/1C)
- Do NOT modify types.ts or the tool registry
- Do NOT modify anything outside your assigned files
- No comments unless the WHY is non-obvious

## Report back
- Files edited
- ts-morph edge cases hit (namespace merging? overloads? default exports?)
- Any deferred behavior (e.g. "overloads collapsed to first signature")
```

## AGENT PROMPT — Phase 1, Agent 1B

```
You are implementing get_references AND the shared related-item helper for
graph-edit. Phase 0 is complete — interfaces locked. Agent 1A and 1C
depend on the related helper you're building.

## Read first
Same reading list as Agent 1A, plus:
- ts-morph findReferences API docs: https://ts-morph.com/navigation/finding-references

## Deliverables
- server/src/tools/get-references.ts — handler for get_references(id)
- Implementation of getReferences in ts-morph-read.ts
- server/src/related.ts — exports `buildRelated(session, sourceId, limit=3): Promise<RelatedItem[]>`
  Strategy for related-item ranking (in order):
    1. Callers/callees of sourceId (via ts-morph findReferences + graph)
    2. Same-module sibling exports
    3. Same-directory test files with same base name

## Requirements
- ts-morph findReferences on a Node returns ReferencedSymbol[] — flatten
  to Reference records per types.ts
- Reference.kind mapping: import statement → "import", type annotation →
  "type_ref", call expression → "call", export from → "reexport", extends
  → "extends", implements → "implements"
- context_line: read the source file, extract the referenced line, strip
  leading/trailing whitespace, cap at 120 chars
- buildRelated: cheap — no full reference walk per candidate; approximate
  from Node.getSourceFile().getReferencedSourceFiles() and neighboring
  exports

## Verification
Same as 1A. Additionally: verify buildRelated returns non-empty results
for a symbol with known callers.

## Constraints
- Do NOT implement listSymbols, getSymbol, find (other agents)
- Do NOT modify types.ts or the tool registry
- Keep buildRelated fast — target <50ms for a mid-size project

## Report back
- Files edited
- Related-item ranking strategy that ended up in the code
- Perf note: how long buildRelated takes on the fixture
```

## AGENT PROMPT — Phase 1, Agent 1C

```
You are implementing the `find` tool for graph-edit with name + usage
modes. Concept mode is deferred to Phase 5.

## Read first
Same list as 1A, plus:
- Existing FTS pattern in /home/max/git/mcp-toolbelt/servers/web-browser/sidecar/src/db.ts
- ts-morph reference walking: https://ts-morph.com/navigation/finding-references

## Deliverables
- server/src/tools/find.ts — dispatch on mode
- server/src/search/name-search.ts — FTS5-like search over symbol names,
  signatures, and jsdoc summaries. For v1: in-memory via micromatch +
  substring scoring (populate on first call, invalidate on session
  reload). SQLite FTS5 is optional — only if you have time.
- server/src/search/usage-search.ts — for queries like "callers of X" or
  "constructors of Y", parse the query for a symbol name + verb, use
  ts-morph refs
- Deferred: mode:"concept" returns a clean error `{ error: "concept
  search deferred to v2 — use mode:'name' or mode:'usage'" }`

## Requirements
- Modes: name, usage, concept, auto (default)
- auto behavior: try name first; if hits < 3 OR top BM25 score < threshold,
  fall back to usage (v1 approximation of "escalate to concept")
- Response includes `hits` count, `top: [{ id, kind, name, signature,
  snippet, score, source_index }]`, `related`, `next_calls`
- Refuse-on-ambiguous: if hits > 20 for a wildcard-style query, return
  `{ hits: N, message: "narrow with kinds= or scope=", top: [first 5] }`

## Verification
- find("Service", mode:"name") returns UserService, AuthService, etc.
- find("callers of UserService.load", mode:"usage") returns call sites
- find("throttling", mode:"concept") returns the deferred error
- find(long query, mode:"auto") escalates from name to usage when name hits are low

## Constraints
- Do NOT implement other Phase 1 tools
- SQLite FTS5 is optional — only implement if in-memory perf is bad for
  the fixture project (>50ms on a ~100-symbol project = go SQLite)

## Report back
- Files edited
- Chose in-memory or SQLite for name-search; perf numbers
- Any query-parsing rules for usage mode (verbs recognized, etc.)
```

## Phase 1 gate
- Every read tool returns non-error responses on a fixture project
- `related` populated across all read tools
- `find` mode dispatch works, concept mode returns deferred error

---

# Phase 2 — Write primitives — structural (parallel, 4 agents)

## Goal
All structural write tools produce PendingMutation records. Nothing
touches disk yet — that's Phase 3 (`commit`).

## Coordination
All 4 agents modify `server/src/backends/ts-morph-write.ts` (assumed
split per Phase 0 note). Split further if collision-prone:
`ts-morph-create.ts`, `ts-morph-edit.ts`, `ts-morph-move.ts`,
`ts-morph-imports.ts`.

## Agent assignments

### Agent 2A — Symbol creation
- `create_symbol`, `add_method`, `add_property`
- `ts-morph-create.ts`: implement above + import inference for method/property
  bodies referencing external symbols

### Agent 2B — Body/signature edits
- `edit_symbol_body`, `edit_symbol_signature`
- `ts-morph-edit.ts`
- For `edit_symbol_signature`: compute BreakingCaller[] via ts-morph
  reference walk + type-diff analysis (compare old vs new param arity/types)

### Agent 2C — Rename/move/delete (the hardest)
- `rename_symbol`, `move_symbol`, `delete_symbol`
- `ts-morph-move.ts`
- rename: use ts-morph's built-in `renameNode` — updates definition + refs atomically
- move: extract text, remove from source, add to target, rewrite every import path
- delete: walk refs, honor refactor_callers policy

### Agent 2D — Import/export/decorator/doc
- `add_import`, `add_export`, `add_decorator`, `set_doc_comment`
- `ts-morph-imports.ts`
- add_import: dedupe, sort per policy from types.PolicyConfig.imports.sort_order
- add_export: barrel-file update (respecting policy `[reexports]`) is Phase 3's job;
  here just add the export declaration to the source file

## Verification for Phase 2
- Every write tool returns a PendingMutation with a uuid and non-empty
  raw_ops
- Warnings populated appropriately (unused_import when creating a symbol
  whose imports were already present, etc.)
- No disk writes — verify with mtime checks on fixture files
- `edit_symbol_signature` produces BreakingCaller records matching a hand-verified list

## AGENT PROMPT — Phase 2, Agent 2A

```
Implement create_symbol, add_method, add_property for graph-edit.
Phases 0 + 1 are complete.

## Read first
- IMPLEMENTATION-MEGAPROMPT.md Phase 2 section
- server/src/types.ts (PendingMutation, Warning shapes)
- server/src/backends/ts-morph-create.ts (skeleton from Phase 0)
- ts-morph creation docs: https://ts-morph.com/manipulation/adding-and-removing/

## Deliverables
- server/src/tools/create-symbol.ts, add-method.ts, add-property.ts
- Implementations in ts-morph-create.ts

## Requirements
- create_symbol args: { kind, name, module?, signature, body?, doc? }
- If module omitted, defer to policy.ts's layoutForNewSymbol(kind, name)
  — that function is stubbed in Phase 0; if it throws "ambiguous", return
  a Warning + refuse the mutation (no PendingMutation)
- Import inference: parse body for identifiers, resolve against project
  symbols via ts-morph, add necessary imports. Emit "unused_import"
  Warning if any inferred import was already in scope.
- add_method args: { class_id, name, signature, body, visibility?, static? }
- add_property args: { class_id, name, type, initializer?, visibility?, readonly? }
- Sort methods per policy.layout.function_grouping (in Phase 3 policy owns
  the file-write; here just append and let Phase 3 reorder)

## Verification
- create_symbol({kind:"function", name:"foo", signature:"function foo(): void", body:"return;"}) on fixture returns a PendingMutation
- add_method on an existing class returns a PendingMutation whose raw_ops
  contain the ts-morph node reference
- No file mtime change after any of these calls
- Warnings surface when import inference produces a dupe

## Constraints
- Do NOT write to disk (Phase 3)
- Do NOT modify types.ts, tool registry, or files owned by other Phase 2 agents

## Report back
- Files edited
- Import-inference edge cases (namespace imports, type-only imports, etc.)
- Any ambiguous cases you left as future work
```

## AGENT PROMPT — Phase 2, Agent 2B

```
Implement edit_symbol_body and edit_symbol_signature. Phase 0+1 complete.

## Read first
- Standard reading list from Phase 2
- ts-morph symbol editing: https://ts-morph.com/manipulation/statements
- BreakingCaller type in server/src/types.ts

## Deliverables
- server/src/tools/edit-symbol-body.ts, edit-symbol-signature.ts
- Implementations in server/src/backends/ts-morph-edit.ts

## Requirements
- edit_symbol_body(id, body): replace body only, preserve signature/name/exports/doc
- edit_symbol_signature(id, signature): change params/return type;
  compute BreakingCaller[] by:
    1. Find all references via ts-morph
    2. For each caller, compare old param arity/types to new
    3. Emit BreakingCaller with kind_of_break = "signature_arity" | "return_type" | etc.
- Return PendingMutation with breaking_callers populated in the mutation record

## Verification
- Editing a body doesn't alter the signature line in the pending diff
- Signature change on a function with 5 callers reports 5 BreakingCallers
  with correct line numbers
- Return-type-only change to a compatible supertype does NOT report a
  BreakingCaller (only report when actually breaking)

## Constraints
- Do NOT touch disk
- Signature parsing: accept the signature as a raw string ("async foo(x: number): Promise<string>")
  and use ts-morph's setBodyText / setReturnType etc. — do NOT hand-parse

## Report back
- Files edited
- BreakingCaller detection: which subset of type changes you handle vs defer
  ("we detect arity + return-type-widening; we do NOT detect covariant param
   changes yet")
```

## AGENT PROMPT — Phase 2, Agent 2C

```
Implement rename_symbol, move_symbol, delete_symbol. Hardest agent in
Phase 2 — cross-file, atomic. Phase 0+1 complete.

## Read first
- Standard Phase 2 reading list
- ts-morph rename: https://ts-morph.com/manipulation/renaming
- Move-file semantics: https://ts-morph.com/manipulation/adding-and-removing (moveToDirectory)

## Deliverables
- server/src/tools/rename-symbol.ts, move-symbol.ts, delete-symbol.ts
- Implementations in server/src/backends/ts-morph-move.ts

## Requirements
- rename_symbol(id, new_name): use ts-morph's rename which updates all refs.
  BEFORE renaming, verify new_name doesn't clash in the target scope
  (existing symbol with same name). Refuse (return { data: null, warnings:
  [{ kind:"name_clash", ...}] } — but wrap in a NotImplementedError-shape
  refusal so it's clear this isn't a PendingMutation)
- move_symbol(id, target_module): 
    1. If target_module doesn't exist, create the source file (empty initially)
    2. Move the declaration node
    3. Rewrite every import path to the new module
    4. If the source file becomes empty after the move, mark it for deletion in the mutation
- delete_symbol(id, refactor_callers): honor the policy
    - "refuse": if callers exist, return a refusal (not a PendingMutation)
    - "inline_last_use": ONLY if exactly one caller and its site is a trivial
      call expression at expression-statement position — inline the body.
      Otherwise refuse.
    - "leave_broken": delete regardless; PendingMutation includes
      BreakingCallers so preview surfaces the type errors

## Verification
- rename_symbol on a fixture with 3 files, symbol referenced in all 3 →
  PendingMutation containing edits to all 3 files
- move_symbol → import statements in every other file update
- delete_symbol with callers + refactor_callers="refuse" returns a refusal
  without a PendingMutation
- delete_symbol("inline_last_use") on a symbol with 2 callers refuses

## Constraints
- Do NOT touch disk (Phase 3 commits)
- Do NOT re-implement rename by hand — use ts-morph.rename
- Refusals must be first-class response shapes, not exceptions

## Report back
- Files edited
- Move-symbol edge cases (moving out of a barrel, moving into a
  namespace-scoped module, name collisions at destination)
- Delete-symbol inline_last_use heuristic — what counts as "trivial"
```

## AGENT PROMPT — Phase 2, Agent 2D

```
Implement add_import, add_export, add_decorator, set_doc_comment for
graph-edit. Phase 0+1 complete.

## Read first
- Standard Phase 2 reading list
- ts-morph imports/exports: https://ts-morph.com/details/imports

## Deliverables
- server/src/tools/{add-import,add-export,add-decorator,set-doc-comment}.ts
- Implementations in server/src/backends/ts-morph-imports.ts

## Requirements
- add_import({module_path, imports: [{name, alias?}]}):
    - Merge with existing import declaration if module_path already imported
    - Dedupe identical imports
    - Sort per PolicyConfig.imports.sort_order (Phase 3 will re-apply this
      globally on commit; here do it locally so the pending diff is stable)
- add_export(id, {from_module?}):
    - Add "export { name }" or "export { name } from '..."
    - Do NOT touch barrel files here (Phase 3 policy owns barrel regeneration)
- add_decorator(id, decorator_source):
    - Insert decorator before the symbol declaration
    - Validate decorator_source parses (via ts-morph)
- set_doc_comment(id, jsdoc_source):
    - Replace existing JSDoc block or add new one
    - Preserve indentation

## Verification
- add_import with a duplicate merges instead of adding a new statement
- add_export on a symbol that's already exported returns a warning
- add_decorator on a non-decoratable node (variable, type) refuses
- set_doc_comment preserves 2-space indent in class methods

## Constraints
- Do NOT touch disk
- Follow the sort_order from PolicyConfig only for the file being edited

## Report back
- Files edited
- Any decorator-target restrictions you enforced
- JSDoc parsing quirks
```

## Phase 2 gate
- All 12 structural write tools return well-formed PendingMutations or refusals
- No fixture files have been modified on disk
- BreakingCaller detection accurate on a hand-verified case

---

# Phase 3 — Session mgmt + policy (parallel, 2 agents)

## Goal
`commit` writes to disk. `preview` returns the health check. Policy
engine decides file placement, imports, barrel files, formatting.

## Agent assignments

### Agent 3A — Session lifecycle
- `preview`, `preview_types`, `commit`, `discard`, `reset_session`, `session_summary`
- `server/src/session.ts` — replace all NotImplemented stubs with real
  session state (pending mutations list, apply on commit, roll back on discard)
- `commit` → writes files via ts-morph's `save()`, then invokes formatter
  via child_process (spawn `prettier --write <touched files>`), then
  runs `tsc --noEmit` (via ts-morph's LanguageService)

### Agent 3B — Policy engine
- `server/src/policy.ts` — full `.graph-edit.toml` parser (schema per types.ts)
- `server/src/layout.ts` — `layoutForNewSymbol(kind, name): ModulePath` that
  Phase 2 Agent 2A already calls (stubbed at Phase 0)
- `server/src/imports.ts` — global import sorting, dedup, unused removal
  (called by session on commit)
- `server/src/barrels.ts` — auto-regenerate `index.ts` barrel files when
  `[reexports].barrel_files = "auto"` and mutations added/removed public exports
- `server/src/naming.ts` — validate/normalize names per `[naming]`
- Formatter integration wrapper (spawn prettier via nix-dev-exec-style
  bubblewrap? No — Phase 3 keeps it simple: direct spawn, since the whole
  graph-edit binary is trusted; sandboxing comes if we later expose
  arbitrary formatter commands)

## Verification for Phase 3
- End-to-end recipe from SKILL.md ("Add a method to a class") works:
  open_symbol → add_method → preview → commit → file mtime changes,
  content matches expected diff
- preview.type_check catches a deliberate type error
- commit refuses on type error unless accept_breaking_callers passed
- Layout policy places a new PascalCase class in `[layout.services]`
  target_dir per the config
- Barrel regeneration: adding a public export updates `src/foo/index.ts`

## AGENT PROMPT — Phase 3, Agent 3A

```
Implement the session lifecycle for graph-edit: preview, preview_types,
commit, discard, reset_session, session_summary. Phase 0-2 complete —
every write tool produces PendingMutations that you now apply.

## Read first
- IMPLEMENTATION-MEGAPROMPT.md Phase 3 section
- server/src/types.ts (PreviewResult, CommitResult, PendingMutation)
- server/src/session.ts (skeleton)
- server/src/backends/ts-morph-write.ts (produces the PendingMutations you apply)
- ts-morph saving: https://ts-morph.com/manipulation/adding-and-removing (save())
- ts-morph LanguageService: https://ts-morph.com/type-checker

## Deliverables
- server/src/session.ts (full impl, replacing all NotImplemented)
- server/src/tools/preview.ts, preview-types.ts, commit.ts, discard.ts,
  reset-session.ts, session-summary.ts

## Requirements
- Session state:
    - project: ts-morph Project instance
    - policy: PolicyConfig
    - pending: PendingMutation[]
    - breakingHistory: BreakingCaller[] accumulated across pending mutations
- preview():
    - Apply pending mutations in-memory via ts-morph (ts-morph tracks
      unsaved changes internally — you're leveraging this)
    - Run policy imports.sort / dedupe / unused-removal in-memory
    - Run formatter in-memory: for each modified source file, spawn
      prettier --stdin-filepath (via child_process.execFile with shell:false),
      pipe file text, receive formatted text, apply to ts-morph SourceFile
    - Run LanguageService diagnostics for type_check
    - Compute diff (before vs after in-memory), imports_added/removed,
      tests_likely_affected
    - Return PreviewResult
- commit(acceptBreakingCallers):
    - Run preview internally
    - If type_check has errors AND (!acceptBreakingCallers OR errors NOT
      subset of breakingHistory), refuse with a clean error including the tsc
      messages
    - Else: project.save() to disk, spawn prettier --write for touched files
      (redundant if preview already applied, but ensures on-disk = in-memory),
      trigger code-graph re-index (best-effort spawn — see composition), return
      CommitResult with intent_recap generated from pending mutations
    - Clear pending on success
- discard(): clear pending, reset ts-morph project to on-disk state
- reset_session(): re-parse from disk (ts-morph refresh)
- session_summary(): return { pending_count, symbols_touched, files_touched,
  breaking_callers_pending, diff_preview: first 2000 chars of preview.diff }

## intent_recap generation
Concatenate per-mutation summaries:
  "added `foo` method to UserService" (from add_method)
  "renamed `login` → `signIn` (27 call sites)" (from rename_symbol)
  "wired `EventBus` import in src/services/user.ts" (from add_import)
Join with "; ". Under 300 chars.

## Verification
1. Fixture project + a series of tool calls per SKILL.md "Add a method to a
   class" recipe → commit writes the expected diff
2. Type error injected → commit refuses with tsc output
3. discard after several mutations → fixture files unchanged
4. reset_session after an out-of-band file edit → session picks up changes

## Constraints
- Do NOT re-implement anything Phase 3 Agent 3B owns (policy, layout,
  barrels, naming, imports sorting). Call into those modules.
- Do NOT invoke prettier via shell string. execFile("prettier", [...], {shell:false})
- code-graph re-index is best-effort: try `spawn` a `code-review-graph
  reindex` command, ignore failures
- No comments unless the WHY is non-obvious

## Report back
- Files edited
- prettier integration: what happens if prettier is missing (skip_if_missing
  policy respected? clean error?)
- tsc diagnostic filtering: any noise you suppressed (import-not-found
  from stale code-graph, etc.)
- Perf: how long does preview take on the fixture project?
```

## AGENT PROMPT — Phase 3, Agent 3B

```
Implement the policy engine for graph-edit: parse .graph-edit.toml,
decide file placement, sort imports, regenerate barrels, validate names.
Phase 0-2 complete.

## Read first
- IMPLEMENTATION-MEGAPROMPT.md Phase 3 section
- server/src/types.ts (PolicyConfig)
- .graph-edit.toml.example (Phase 0 created it)
- servers/fs-fallback/server/src/policy.ts (reference TOML pattern)
- servers/graph-edit/README.md "Serialization policy" section

## Deliverables
- server/src/policy.ts — full loader/validator (upgrade the Phase 0 stub)
- server/src/layout.ts — layoutForNewSymbol(kind, name, project?): ModulePath
- server/src/imports.ts — sortImportsInFile(sourceFile, policy) +
  dedupImports(sourceFile) + removeUnusedImports(sourceFile)
- server/src/barrels.ts — regenerateBarrels(project, policy, changedFiles): SourceFile[]
- server/src/naming.ts — validateSymbolName(name, kind, policy) + normalize helpers

## Requirements
- Layout: walk PolicyConfig.layout.groups; first regex match wins;
  target_dir + naming rules produce the final filename. Fallback:
  project.root_dir + kebab-case(name) + ".ts"
- If no rule matches and no fallback fires, throw a specific
  LayoutAmbiguousError that Agent 2A converts to a refusal
- Import sort order per PolicyConfig.imports.sort_order — implement
  bucketing: node builtins, external (starts with letter), absolute (matches
  absolute_prefix like "@/"), relative (starts with "."). Sort within each
  bucket lex.
- Barrel regeneration: for each directory containing an index.ts and marked
  auto-managed, walk sibling files, collect exports tagged @public (or all
  exports if public_marker not set), emit an index.ts with `export { X, Y
  } from './foo'` entries. Preserve manual re-exports (comments-marked
  "// manual" or non-generated blocks).
- Naming: PascalCase / camelCase / SCREAMING_SNAKE_CASE / kebab-case —
  small regexp validators + normalizers

## Verification
- Fixture with a `[layout.services]` rule and a `Foo` service → layoutForNewSymbol
  returns "src/services/foo.ts" (with kebab naming)
- Two duplicate imports → dedupImports collapses to one
- Adding an unused import → removeUnusedImports drops it (only if
  policy.imports.remove_unused)
- Adding a @public export to src/foo/bar.ts → regenerateBarrels updates
  src/foo/index.ts if it exists
- Bad name for kind → validateSymbolName returns { valid: false, hint: ... }

## Constraints
- Do NOT touch disk (Agent 3A does that on commit)
- Do NOT touch session state (Agent 3A owns it)
- Barrels: skip index.ts files whose first line is "// manual" or
  "// @not-managed"

## Report back
- Files edited
- Layout precedence rules you implemented in order
- Barrel-file heuristic for detecting "manual" barrel files
- Any policy field you couldn't implement cleanly (with rationale)
```

## Phase 3 gate
- SKILL.md recipe walk-through executes end-to-end
- Preview health check accurate
- Commit refusal on type errors works
- Policy places a new symbol per config

---

# Phase 4 — Bundled context tools (parallel, 3 agents)

## Goal
Replace multi-call agent workflows with one-shot bundled tools.

## Agent assignments

### Agent 4A — open_symbol + similar_to
- `open_symbol(id_or_query)`: symbol + callers + type deps + siblings +
  tests + related
- `similar_to(id, k?)`: for v1 without embeddings, "similar" = same-module +
  same-kind + shared type refs. Vector-nearest is Phase 5.

### Agent 4B — explore
- `explore(intent, target?)`: task-oriented briefing. For v1, semantic
  matching is keyword-based (extract salient nouns/verbs from intent,
  find matching symbols by name + jsdoc FTS). Return the target, existing
  patterns, related infra (imports of common libs matching the intent
  domain), tests, `.graph-edit.toml` layout preview for a new symbol.

### Agent 4C — describe_change_zone + session_summary
- `describe_change_zone(id)`: pre-edit blast radius — every caller + line
  that would break under sig change, type refs, mocking tests, re-exports,
  is_public_api heuristic
- `session_summary` is really owned by Phase 3 Agent 3A; if 3A punted,
  4C picks it up. Coordinate to avoid duplicate.

## Verification for Phase 4
- open_symbol on UserService returns 6 populated top-level fields
- explore("add caching to UserService.load") returns a briefing with
  the target, cache-related patterns (if any exist in fixture), tests
- describe_change_zone on a public symbol → is_public_api: true

## AGENT PROMPTS — Phase 4

Structure the three prompts like Phase 1. Emphasize:
- These tools compose the Phase 1-3 primitives internally
- Don't reimplement anything — call session methods
- The whole point is fewer round trips for the agent, so response bodies
  are richer than any single primitive

Each agent's prompt should mirror the Phase 1 template with reading list,
deliverables, requirements, verification, constraints, report format.
(Omitted here for brevity — copy the Phase 1A template shape.)

## Phase 4 gate
- SKILL.md's "understand a codebase" recipe works with just `explore`
- open_symbol response replaces 3-4 primitive calls

---

# Phase 5 — Search: name + usage (parallel, 2 agents) — concept mode DEFERRED

## Goal
Upgrade `find` beyond the Phase 1 in-memory scaffolding. Add SQLite FTS5
for name/signature search if not already. Add smarter usage-mode query
parsing.

**Concept mode (embeddings) is DEFERRED to v2.** Phase 5 v1 scope covers
only name + usage improvements. Two agents keep Phase 5 fast.

## Agent assignments

### Agent 5A — FTS5-backed name search
- `server/src/search/fts-index.ts` — SQLite FTS5 at
  `~/.cache/mcp-toolbelt/graph-edit-<projectHash>.db`, rebuilt on session
  load
- Migrate `server/src/search/name-search.ts` to consult FTS5 when
  available, fall back to in-memory otherwise
- Index columns: name, signature, jsdoc_summary (first 200 chars of jsdoc)
- Tokenizer: porter unicode61

### Agent 5B — Usage query parser
- Expand `server/src/search/usage-search.ts` with a small grammar:
  - "callers of X" → get_references(X) filtered to kind:"call"
  - "constructors of X" → find "new X(" occurrences
  - "implementations of I" → subclasses/implementors
  - "type of X" → get_symbol(X).signature return type resolution
- Response: hits + top + related + next_calls

## Phase 5 gate
- find("Service", mode:"name") returns FTS5 ranked results
- find("callers of UserService.load", mode:"usage") returns 5+ hits with
  correct kinds

---

# Phase 6 — Integration + tests (parallel, 3 agents)

## Goal
Wire graph-edit into the root flake, extend the test suite, add a NixOS
VM scenario. Same pattern the 5 earlier servers followed.

## Agent assignments

### Agent 6A — Root flake integration
- Add `graph-edit.url = "path:./servers/graph-edit";` input
- Extract `graphEditPkg` in outputs
- Add to `packages` map, `mkDevShell` flags, `devShells.default`
- Update `scripts/claude-with-servers` to register graph-edit
- Update root `README.md` server catalog: change graph-edit row to
  "packaged"

### Agent 6B — Fixture + smoke + scenario tests
- `tests/fixtures/graph-edit-sample/` — a small TS project with:
  - `src/services/user.ts` (UserService class with `load`, `save`, tests
    imports)
  - `src/services/auth.ts` (AuthService)
  - `src/components/UserCard.tsx` (React FC — exercises [layout.components])
  - `src/hooks/useDebounce.ts` (exercises [layout.hooks])
  - `src/utils/format.ts`
  - `src/services/user.test.ts`, index.ts barrels
  - `.graph-edit.toml` with layout rules for services/components/hooks
  - `tsconfig.json`, `package.json` (with ts-morph-inference-friendly deps)
- `tests/graph-edit.sh` — mcp_smoke_test + mcp_expect_tools with all ~32
  tool names
- `tests/scenarios/graph-edit-workflow.sh` — the SKILL.md recipes as
  assertions:
  - "Add method to class": open_symbol → add_method → preview → commit;
    verify final diff matches expected
  - "Rename across codebase": describe_change_zone → rename_symbol →
    commit; verify all 3 fixture files updated
  - "Understand codebase": explore("add rate limiting") returns a
    briefing with expected shape (some fields non-empty)
  - "Delete unused code": delete_symbol with refactor_callers="refuse" →
    commit refused because callers exist
- Update `tests/integration.sh` EXPECTED_SERVERS list

### Agent 6C — VM test extension
- Extend `tests/vm/default.nix` to also install graph-edit
- Add a graph-edit scenario to the VM Python testScript
- Add a sandbox-probe for graph-edit: verify preview's formatter spawn
  runs (if we later sandbox it), verify commit failure on type errors

## Phase 6 gate
- `make check` passes with graph-edit smoke + scenario
- `nix flake check --no-build` clean
- VM test builds + runs

---

# Phase 7 — Ecosystem wiring (serial, 1 agent)

## Goal
Point the rest of the toolbelt at graph-edit as the primary source-edit
path.

## Deliverables
- Update `servers/fs-fallback/server/src/policy.ts` refusal messages:
  "source-code writes go through graph-edit (preferred: `open_symbol` →
  `add_method` / `edit_symbol_body`) or edit-surface (anchor-based fallback)"
- Update `servers/fs-fallback/.fs-fallback.toml.example` — mark
  `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx` as `deny` (routing to
  graph-edit)
- Add a paragraph to `RUNBOOK.md` about graph-edit as the primary source
  editing path
- Update `servers/graph-edit/README.md` status line: "design only" → "packaged (TS v1)"
- Optional: install `SKILL.md` symlink at `.claude/skills/graph-edit/SKILL.md`
  in the project root so Claude Code picks it up when run from mcp-toolbelt

## Phase 7 gate
- `fs-fallback` refuses `.ts` writes and hints at graph-edit
- `edit-surface` remains for languages graph-edit doesn't back

---

# Cross-cutting concerns

## Interface amendments
If any Phase 1+ agent needs an interface change (added field on
SymbolDetail, new arg on a tool), the orchestrator must:
1. Halt the phase
2. Update `types.ts` centrally
3. Re-dispatch affected agents with the amendment noted

Prefer additive amendments (new optional fields) over breaking ones.

## Perf targets
- Session load on a 500-file TS project: <5s
- open_symbol response: <200ms
- preview: <1s
- commit (after preview): <500ms + prettier + tsc time
- FTS5 index build: <2s

Miss any target by 2x → investigate before Phase 6.

## Testing philosophy
- Every phase gate is enforced by running `make check` + smoke tests
- Phase 6 introduces scenario tests that assert on real diffs — those
  should not depend on formatting whitespace (compare parsed AST or
  strip trailing whitespace before diffing)
- VM test doesn't need network — everything runs offline

## Rollback / recovery
- If a phase's agent produces broken code that blocks subsequent phases,
  roll back with `git restore servers/graph-edit/` (agents should commit
  nothing — the orchestrator is responsible for atomic commits per phase)
- Orchestrator commits after each phase gate passes

## What to do if an agent overreaches
Agents may try to "helpfully" implement more than their assignment. If
Agent 2A implements delete_symbol thinking it's simple, roll back that
file and re-dispatch with tighter constraints. Don't merge overreach —
Agent 2C owns delete_symbol and their coordination context (breaking
callers via ts-morph refs) is different from 2A's context.

---

# Recommended dispatch commands

Use the Agent tool with `subagent_type: "general-purpose"`. Run
`run_in_background: true` for all agents in a parallel phase; wait for
all completions before advancing.

Between phases:
1. `cd servers/graph-edit/server && npm run build` — 0 errors
2. `cd .. && nix build -L` — passes
3. `bash tests/graph-edit.sh` (once it exists) — passes
4. Commit: `git add servers/graph-edit tests/graph-edit* tests/scenarios/graph-edit* tests/fixtures/graph-edit* flake.nix scripts/claude-with-servers README.md`
   with message like `feat(graph-edit): phase N — <summary>`

# Final check

At the end of Phase 7, verify:
- `nix build .#graph-edit` builds
- `make check` passes with graph-edit-specific tests
- `nix flake check` passes both smoke-tests and vm-integration
- Root README catalog shows graph-edit as "packaged"
- fs-fallback refuses .ts writes and points to graph-edit
- SKILL.md recipes execute end-to-end against the fixture

Total agent count: 1 (Phase 0) + 3 (Phase 1) + 4 (Phase 2) + 2 (Phase 3)
+ 3 (Phase 4) + 2 (Phase 5) + 3 (Phase 6) + 1 (Phase 7) = **19 agent
invocations**, of which 14 are parallelizable within their phase.

Estimated real time: ~4-6 hours of subagent work, plus orchestrator
verification time between phases. Wall-clock will depend on how much
the orchestrator can safely run in parallel and how quickly it verifies
phase gates.
