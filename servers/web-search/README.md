# web-search

Nix packaging for [`pskill9/web-search`](https://github.com/pskill9/web-search)
(pinned to commit `1b3ead8`) — a Model Context Protocol server that performs
web searches via Google scraping. **No API key required.**

## Upstream research

| Field | Value |
|---|---|
| npm package | Not published to npm |
| Latest release | **None** — single-commit repo; pin to `1b3ead82b45e81af4e27467f1db90168b22fe7ef` |
| Repository | [pskill9/web-search](https://github.com/pskill9/web-search) |
| License | **None specified** — no LICENSE file, no `license` field in package.json, GitHub API reports `null`. See [License caveat](#license-caveat) below. |
| Node.js | Not specified (targets ES2022, uses Node16 module resolution) |
| Build system | TypeScript + tsc (ES modules, `src/` -> `build/`) |
| Entry point | `build/index.js` (bin: `web-search`) |
| Stdio mode | Uses `StdioServerTransport` — no special flags needed |
| CLI flags | None |

### License caveat

The upstream repository has **no license file and no license field** in
`package.json`. Under default copyright law, this means the code is
"all rights reserved." For internal/personal use this is low-risk, but
redistribution may be legally ambiguous. If this matters for your use case,
consider opening an issue upstream requesting an explicit license, or switch
to a licensed alternative (Tavily, Exa — see below).

### Runtime dependencies

| Package | Version |
|---|---|
| @modelcontextprotocol/sdk | 0.6.0 |
| axios | ^1.7.9 |
| cheerio | ^1.0.0 |

Dev/type-only (not needed at runtime):

| Package | Version |
|---|---|
| @types/axios | ^0.14.4 |
| @types/cheerio | ^0.22.35 |
| @types/node | ^20.17.10 |
| typescript | ^5.3.3 |

### MCP tools provided

The server exposes 1 tool over MCP:

- `search` — searches the web via Google scraping (no API key). Parameters:
  - `query` (string, required): the search terms
  - `limit` (number, optional): max results to return, 1-10, default 5

Returns an array of `{ title, url, description }` objects.

### How it works

The server constructs a Google search URL from the query string, fetches the
HTML with `axios`, then parses results using `cheerio` (targeting `div.g`
elements, extracting `h3` titles, `a` hrefs, and `.VwiC3b` snippets). This is
pure HTML scraping — no headless browser, no API key, no Playwright.

### Google rate-limit behavior

Google may block or CAPTCHA requests if searches are too frequent from a
single IP. There is **no built-in rate limiting** in this server. Observed
behavior:

- **Low frequency** (a few searches per minute): works reliably
- **High frequency** (many searches in quick succession): Google returns
  CAPTCHA pages or HTTP 429, causing empty results or errors
- **Mitigation**: the `limit` parameter caps results per query (max 10),
  reducing response size but not request frequency

If you hit rate limits regularly, upgrade to Tavily or Exa (see below).

## Opt-in upgrades: Tavily and Exa

The default Google-scraping backend requires no API key but has quality and
rate-limit trade-offs. Two paid alternatives offer better ranking and
reliability:

### Tavily

[tavily-ai/tavily-mcp](https://github.com/tavily-ai/tavily-mcp) — AI-optimized
search with semantic ranking.

| Field | Value |
|---|---|
| Install | `npx tavily-mcp@latest` or add as a separate Nix flake input |
| API key env var | `TAVILY_API_KEY` |
| Pricing | Free tier (1,000 searches/month), paid tiers available |
| Quality | Semantic ranking optimized for AI agents |

To use: set `TAVILY_API_KEY` in your environment and configure a separate
MCP server entry pointing at the Tavily binary instead of `web-search`.

### Exa

[exa-labs/exa-mcp-server](https://github.com/exa-labs/exa-mcp-server) — neural
search engine with embeddings-based retrieval.

| Field | Value |
|---|---|
| Install | `npx exa-mcp-server@latest` or add as a separate Nix flake input |
| API key env var | `EXA_API_KEY` |
| Pricing | Free tier available, paid tiers for higher volume |
| Quality | Neural/embeddings-based search |

To use: set `EXA_API_KEY` in your environment and configure a separate
MCP server entry pointing at the Exa binary instead of `web-search`.

## Packaging notes

- Not published to npm — must use `fetchFromGitHub` for Nix packaging.
  The repo contains `package-lock.json` (lockfileVersion 3), so
  `buildNpmPackage` works directly.
- Single commit repo (`1b3ead8`, 2024-12-30). Pin to this commit hash.
- No GitHub releases or tags exist.
- `@types/axios` and `@types/cheerio` are listed as runtime deps in
  `package.json` but are type-only — they're harmless at runtime but not
  needed. Don't bother patching them out.
- The bin field is `"web-search": "./build/index.js"` — this becomes the
  binary name in `meta.mainProgram`.
- No native addons — pure JS/TS, straightforward `buildNpmPackage`.

## Standalone use

```nix
{
  inputs.web-search.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/web-search";

  outputs = { self, nixpkgs, flake-utils, web-search }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in
      {
        devShells.default = pkgs.mkShell {
          packages = [ web-search.packages.${system}.default ];
        };
      });
}
```

## Composition

Pairs naturally with [`web-browser`](../web-browser/): the agent calls
`web-search`'s `search(query)` to discover URLs, then
`web-browser.read_website(url)` to fetch+extract+cache them.
