# docs-fetcher (design only)

Slot for an MCP server that downloads version-pinned documentation for every
tool and dependency a project actually uses, then exposes it over MCP so the
agent looks up the *right* docs instead of guessing from training data.

## Status

Design only — no implementation yet. This README captures the intent so the
slot doesn't get filled with the wrong thing later.

## What it should do

1. **Discover what the project uses.** Read manifests (`package.json`,
   `pyproject.toml`, `Cargo.toml`, `go.mod`, `flake.lock`, …) to enumerate
   dependencies with their exact resolved versions.
2. **Fetch matching docs.** For each dependency, pull the documentation for
   *that version* — not "latest" — from the canonical source (the package's
   own docs site, GitHub release notes, or the registry). Cache locally,
   keyed by name+version, so re-runs are free.
3. **Expose over MCP.** Provide tools like:
   - `list_docs()` — what's indexed.
   - `search_docs(query, name?, version?)` — semantic + keyword search.
   - `fetch_section(name, version, section)` — return a specific section.
   - `get_changelog(name, from_version, to_version)` — diff release notes.
4. **Stay incremental.** Re-run on lockfile change; only fetch what's new.

## Open design questions

- **Storage format.** SQLite with FTS? Flat markdown + an index? Reuse the
  `code-review-graph` storage layer?
- **Source resolution.** Per-ecosystem adapters, or a single heuristic
  (registry → repo → docs site)?
- **Auth/network.** Most public docs are open; some live behind auth (private
  registries, paid docs). Scope v0.1 to public sources only?
- **Version semantics.** Some projects only publish docs for `latest` and tag
  them with git tags inside their repo — adapter must follow that pattern.

## Why this belongs in the toolbelt

The graph server tells the agent where things are; the docs-fetcher tells the
agent how things *work* at the exact version it'll touch. Together they cut
the two biggest sources of hallucinated code: invented APIs that don't exist
in the codebase, and invented behavior that doesn't exist in the dependency.

Open an issue or PR if you want to drive this one.
