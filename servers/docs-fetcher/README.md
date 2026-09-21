# docs-fetcher

MCP server that walks a project's manifests (`package.json`, `Cargo.toml`,
`pyproject.toml`), resolves each dependency to its canonical docs URL **for
that exact version**, fetches the pages via `fetcher-mcp`, and indexes the
result into a local SQLite FTS5 cache with **tech tags** as first-class
filter columns.

The differentiator vs. `web-browser` (which caches whatever the agent
happens to `fetch_url`): docs-fetcher is *manifest-driven*. It knows what
your project actually uses, and its search is tag-filtered, so
`search("async runtime", tech="rust")` will only ever hit Rust docs even
when the corpus also contains TypeScript, Python, and Go entries.

## Status

**Packaged.** Nix-built, TypeScript sidecar around `fetcher-mcp`, FTS5 cache
at `~/.cache/mcp-toolbelt/docs-cache.db`. See "What's not implemented" at
the end for known gaps.

## MCP tools

| Tool | Description |
|---|---|
| `list_manifests` | Enumerate discovered manifests (walks down from cwd and up to `/`). |
| `list_deps` | For each dep across all manifests: `{ecosystem, language, package, version, resolved_url, indexed}`. Accepts optional `manifest_path`. |
| `warm_docs` | Resolve + fetch + section-split + index every not-yet-indexed dep. `force` refetches. Returns per-package `{fetched, skipped, failed}`. |
| `search` | FTS5 BM25 across cached section content. Tag filters: `tech` (rust\|typescript\|python\|go), `package`, `version`, `limit`. |
| `list_indexed` | Enumerate cached packages with `section_count` and `fetched_at`. Filter by `tech` or `package`. |
| `get_section` | Full content of one section by `(package, version, section_path)`. |
| `purge` | Drop rows for a package (all versions, or one). |

### Tagged-search examples

```jsonc
// "How does tokio spawn tasks?" — restrict to Rust so the answer isn't
// polluted by JS Promise or Python asyncio hits.
{ "name": "search", "arguments": { "query": "spawn task", "tech": "rust" } }

// "What does @modelcontextprotocol/sdk expose?" — filter by package + version.
{ "name": "search",
  "arguments": {
    "query": "server tool handler",
    "package": "@modelcontextprotocol/sdk",
    "version": "1.12.0"
  } }

// "What Rust crates do I have indexed?"
{ "name": "list_indexed", "arguments": { "tech": "rust" } }
```

## Manifest adapters

| Ecosystem | Adapter status | Version source |
|---|---|---|
| npm (`package.json`) | Fully wired | `package-lock.json` (v2/v3 + v1 fallback) → `pnpm-lock.yaml` → declared spec |
| cargo (`Cargo.toml`) | Fully wired | `Cargo.lock` `[[package]]` entries → declared spec |
| PyPI (`pyproject.toml`) | Fully wired | `uv.lock` → `poetry.lock` → PEP 621/Poetry declared spec |
| Go (`go.mod`) | **Stub** — returns `[]` + warning | — |

If a single manifest fails to parse, `list_deps` logs a warning in the
response and continues with the others. `warm_docs` treats each dep
independently: one failure does not abort the batch.

### Per-ecosystem docs URLs

| Ecosystem | Canonical URL template |
|---|---|
| npm | `https://unpkg.com/{name}@{version}/README.md` (plain HTTP, no JS) |
| cargo | `https://docs.rs/{name}/{version}/{name}/` (crate root; needs JS render) |
| PyPI | `https://pypi.org/pypi/{name}/{version}/json` — the `info.description` field is extracted as the README before section splitting |
| Go | `https://pkg.go.dev/{module}@{version}` (stub — not fetched yet) |

## Storage

- **Location:** `~/.cache/mcp-toolbelt/docs-cache.db` (respects
  `XDG_CACHE_HOME`). User-global — one docs cache per machine, shared across
  projects, keyed by `(package, version, section_path)`.
- **Engine:** SQLite with WAL + FTS5 (`tokenize='porter unicode61'` for
  stemming and Unicode).
- **Schema:**
  - `docs(id, url, ecosystem, language, package, version, section_path,
    title, content, fetched_at)` with `UNIQUE(package, version,
    section_path)`.
  - `docs_fts(package, version, title, content)` external-content over
    `docs`, kept in sync via `AFTER INSERT/UPDATE/DELETE` triggers.
- **Tags are columns**, not a separate table — cheap filters via
  `WHERE language = ? AND package = ?`. Ecosystem → language mapping:
  `npm → typescript`, `cargo → rust`, `pypi → python`, `go → go`.
- **Section splitting:** the fetched markdown is split by top-level `#`/`##`
  headings; each section is one row. Better BM25 relevance than dumping
  the whole README into a single blob.

## Packaging notes

- Nix flake with `buildNpmPackage`. `npmDepsHash` refreshed by running
  `prefetch-npm-deps ./server/package-lock.json` after `npm install`.
- Native `better-sqlite3` — `python3` + `pkg-config` in `nativeBuildInputs`,
  `nodejs` in `buildInputs`, `makeCacheWritable = true`.
- The `docs-fetcher` binary is wrapped so `fetcher-mcp` (from the sibling
  `web-browser` flake) is on its `PATH`. The child process is spawned via
  `StdioClientTransport`; no shell strings, `shell: false`.
- Rate limiting: 200 ms between fetches by default. Override with
  `DOCS_FETCHER_DELAY_MS`.

## Standalone use

```nix
{
  inputs.docs-fetcher.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/docs-fetcher";

  outputs = { self, nixpkgs, flake-utils, docs-fetcher }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in
      {
        devShells.default = pkgs.mkShell {
          packages = [ docs-fetcher.packages.${system}.default ];
        };
      });
}
```

Then wire it into your MCP client:

```jsonc
{
  "mcpServers": {
    "docs-fetcher": { "command": "docs-fetcher" }
  }
}
```

Typical session:

```
> list_manifests()
> list_deps()          // dry run — see what would be fetched
> warm_docs()          // populate the cache (200 ms between requests)
> search("bearer token", tech="typescript")
> get_section(package="hono", version="4.6.14", section_path="Middleware")
```

## Composition

`docs-fetcher` complements `web-browser`: web-browser caches ad-hoc pages
the agent fetches; docs-fetcher pre-warms the exact-version docs for every
dependency in the project. `code-graph` tells the agent where symbols are;
`docs-fetcher` tells it what those symbols *do* at the version being
touched.

## Open design questions

- **Embeddings.** DESIGN.md commits to FTS5 over vector stores for
  determinism and zero embedding-model dependency. Tag filters + BM25 have
  covered every case tried so far; revisit only if a concrete miss shows up
  where semantic similarity would have helped.
- **Private registries.** GitHub Packages, Artifactory, a self-hosted
  PyPI — all require auth. v0.1 is public sources only. Adding auth
  probably means an env-var-driven credential map (`DOCS_FETCHER_NPM_TOKEN`,
  `DOCS_FETCHER_PYPI_URL`), fanned out per-ecosystem.
- **docs.rs depth.** Currently we fetch only the crate root
  (`/docs.rs/{name}/{version}/{name}/`). Full trait/struct pages would 10-100x
  the crawl cost. A follow-up option `warm_docs(depth: "root" | "items")`
  could opt into the deeper crawl.
- **Go adapter.** `go.mod` parsing is a stub. Implementing it means either
  a minimal manual parser (formatted grammar is simple) or shelling out to
  `go list -m -json all`.
- **Changelog diffing.** The original design floated `get_changelog(name,
  from, to)`. Not in v0.1 — implementing it well needs release-notes
  scraping per-ecosystem, and the FTS5 store already lets the agent search
  across two versions if both are warmed.
