# web-browser

Nix packaging for [`jae-jae/fetcher-mcp`](https://github.com/jae-jae/fetcher-mcp)
(pinned to tag `v0.3.9`) plus a **custom sidecar** that layers an FTS5-backed
page cache on top. The agent gets Playwright-rendered markdown *and* the
ability to search across every page it has ever fetched.

## Upstream research

| Field | Value |
|---|---|
| Upstream repo | [jae-jae/fetcher-mcp](https://github.com/jae-jae/fetcher-mcp) |
| Version | **v0.3.9** (commit `8754aff`) |
| License | ISC |
| Language | TypeScript (Node.js >=20) |
| Runtime deps | Playwright 1.51.1 (Chromium), Mozilla Readability, Turndown |
| Entry point | `fetcher-mcp` binary — stdio MCP, no flags |

### Upstream tools (proxied unchanged)

| Tool | Description |
|---|---|
| `fetch_url` | Render a URL with Playwright, extract main content via Readability, convert to markdown with Turndown |
| `fetch_urls` | Batched form of `fetch_url` |

### Sidecar tools (added by this flake)

The sidecar (`sidecar/src/index.ts`) spawns `fetcher-mcp` as a stdio child,
forwards `tools/list` and `tools/call` to it, and on every successful
`fetch_url`/`fetch_urls` writes the extracted markdown into SQLite. It also
exposes four additional tools:

| Tool | Description |
|---|---|
| `search_cached` | FTS5 BM25 search across cached pages. Returns `[{url, title, fetched_at, snippet}]`. Supports AND/OR/NOT and phrases. |
| `get_cached` | Return full markdown for a previously fetched URL — no network. |
| `list_cached` | Enumerate cached URLs ordered by most-recent fetch (`limit`, `offset`). |
| `purge_cached` | Drop a stale row when an upstream doc page has changed. |

## Storage

- **Location:** `~/.cache/mcp-toolbelt/web-cache.db` (respects `XDG_CACHE_HOME`).
  User-global — one cache shared across every project on the machine.
- **Engine:** SQLite with WAL journaling + FTS5 (BM25 ranking).
- **Schema:**
  - `pages(id, url UNIQUE, title, fetched_at, markdown)`
  - `pages_fts(title, markdown)` — external-content FTS5 table over `pages`,
    kept in sync via `AFTER INSERT/UPDATE/DELETE` triggers.
- **Write path:** `INSERT OR REPLACE` on URL — refetching the same URL replaces
  the row so the freshest copy wins.
- See `sidecar/src/db.ts` for the schema and prepared statements.

## Packaging notes

- Two packages exposed by the flake:
  - `web-browser-sidecar` (default) — the sidecar binary, wrapped so
    `fetcher-mcp` is on its `PATH`.
  - `fetcher-mcp` — the upstream server on its own, for users who don't want
    the cache layer.
- **Upstream is untouched.** When `fetcher-mcp` cuts a new release, bump the
  `rev`/`hash`/`npmDepsHash` in `flake.nix` and the sidecar keeps working.
- **Playwright browser compat layer** (`playwrightBrowsersCompat` in
  `flake.nix`): fetcher-mcp v0.3.9 bundles Playwright 1.51.1, which expects
  Chromium at revision-specific paths like
  `chromium_headless_shell-1161/chrome-linux/headless_shell`. Nixpkgs'
  `playwright-driver` may ship a newer revision with a different layout
  (e.g. `chromium_headless_shell-1217/chrome-headless-shell-linux64/…`).
  The derivation creates a symlink tree mapping the paths Playwright expects
  onto whatever nixpkgs actually provides.
- The sidecar uses `better-sqlite3` — `python3` and `pkg-config` are in
  `nativeBuildInputs` for the node-gyp build of the native addon.
- Playwright browser download is skipped at npm install time
  (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, `--ignore-scripts`); the compat
  layer supplies the browsers at runtime via `PLAYWRIGHT_BROWSERS_PATH`.

## Standalone use

```nix
{
  inputs.web-browser.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/web-browser";

  outputs = { self, nixpkgs, flake-utils, web-browser }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in
      {
        devShells.default = pkgs.mkShell {
          packages = [ web-browser.packages.${system}.default ];
        };
      });
}
```

Run `web-browser-sidecar` and point your MCP client at its stdio — you get
both the upstream `fetch_url*` tools and the four `*_cached` tools in one
server.

## Composition

`web-browser` replaces the built-in `WebFetch` tool. The cache means the
agent can call `search_cached("react hooks useEffect")` instead of re-fetching
the same page every turn, and `get_cached(url)` returns instantly without
touching the network. The private SQLite DB is self-contained; if
`sqlite-store` later becomes canonical, the sidecar can migrate to writing
into its `web.*` namespace without changing tool shapes.

## Disqualified alternatives

- `@just-every/mcp-read-website-fast` — pure HTTP + Readability, no Chromium.
  Lighter, but SPA docs (Stripe, Vercel, modern API references) return
  garbage because nothing renders the JS. Playwright is the price of
  handling the modern web.
- Firecrawl / Tavily / Exa — paid API keys, wrong default for a flake
  collection.
- Microsoft `playwright-mcp` — returns verbose accessibility trees, designed
  for browser automation, not doc reading.
