# web-browser

Nix packaging for [`mcp-read-website-fast`](https://github.com/just-every/mcp-read-website-fast)
(MIT, pinned to v0.1.22) — a Model Context Protocol server that fetches web
pages and converts them to clean, token-efficient Markdown for AI agents.

## Upstream research

| Field | Value |
|---|---|
| npm package | [`@just-every/mcp-read-website-fast`](https://www.npmjs.com/package/@just-every/mcp-read-website-fast) |
| Latest release | **v0.1.22** (semver, tag on GitHub; published to npm) |
| Repository | [just-every/mcp-read-website-fast](https://github.com/just-every/mcp-read-website-fast) |
| License | MIT |
| Node.js | >=20.0.0 |
| Build system | TypeScript + tsc (ES modules) |
| Entry point | `bin/mcp-read-website.js` (bin: `mcp-read-website-fast`) |
| Stdio mode | Default command is `serve` (runs when no args given); uses `StdioServerTransport` — no special flags needed |
| CLI flags | `--cache-dir <path>` (default: `.cache`), `--no-robots`, `-t/--timeout <ms>`, `-c/--concurrency <num>`, `-p/--pages <num>` |

### Disk cache configuration

- **Default location**: `.cache` directory relative to the working directory
- **CLI flag**: `--cache-dir <path>` overrides the default on `fetch` and `clear-cache` subcommands
- **Environment variable**: None — cache location is only configurable via CLI flag or the `cacheDir` option in the `fetchMarkdown()` API
- **Cache management**: MCP resources `read-website-fast://status` (size metrics) and `read-website-fast://clear-cache` (purge); CLI `clear-cache` subcommand also available

### Runtime dependencies

| Package | Version constraint |
|---|---|
| @just-every/crawl | ^1.0.8 |
| @modelcontextprotocol/sdk | ^1.29.0 |
| commander | ^14.0.3 |
| turndown-plugin-gfm | ^1.0.2 |
| uuid | ^13.0.0 |

### MCP tools provided

The server exposes 1 tool over MCP:

- `read_website` — fetches a URL and converts the HTML to clean Markdown. Parameters: `url` (required), `pages` (optional, max 100 — controls crawl depth), `cookiesFile` (optional, path to cookies file for authenticated pages)

### MCP resources provided

- `read-website-fast://status` — cache size in MB and file count
- `read-website-fast://clear-cache` — purge the disk cache

## Packaging notes

- Published to npm as `@just-every/mcp-read-website-fast` — use `fetchurl` from the npm registry or `fetchFromGitHub` with matching tag.
- Pure HTTP + Readability extraction — **no Playwright or browser dependency**. This is intentionally lightweight compared to `fetcher-mcp`.
- The entry point (`bin/mcp-read-website.js`) auto-detects production vs dev mode and loads from `dist/` in production.
- `serve-restart.ts` wraps the MCP server with auto-restart and exponential backoff (up to 10 restarts in 60s). When run via `npx` or as a Nix package, the restart wrapper is the default entry.
- Use `buildNpmPackage` with `npmDepsHash` for reproducible builds.
- No GitHub releases exist — pin to the `v0.1.22` git tag.

## Standalone use

```nix
{
  inputs.web-browser.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/web-browser";

  outputs = { self, nixpkgs, flake-utils, web-browser }:
    flake-utils.lib.eachDefaultSystem (system: {
      devShells.default = nixpkgs.legacyPackages.${system}.mkShell {
        packages = [ web-browser.packages.${system}.mcp-read-website-fast ];
      };
    });
}
```
