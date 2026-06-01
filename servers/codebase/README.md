# codebase

Nix packaging for [`tree-sitter-mcp`](https://github.com/nendotools/tree-sitter-mcp)
(GPL-3.0, pinned to v2.8.2) — a Model Context Protocol server providing
tree-sitter-powered code search, analysis, and error detection for LLMs.

## Upstream research

| Field | Value |
|---|---|
| npm package | [`@nendo/tree-sitter-mcp`](https://www.npmjs.com/package/@nendo/tree-sitter-mcp) (not published to npm — install from GitHub) |
| Latest release | **v2.8.2** (semver) |
| Repository | [nendotools/tree-sitter-mcp](https://github.com/nendotools/tree-sitter-mcp) |
| License | GPL-3.0 |
| Node.js | >=18.0.0 |
| Build system | TypeScript + tsc |
| Entry point | `dist/cli.js` (bin: `tree-sitter-mcp`) |
| Stdio mode | `--mcp` flag or non-TTY stdin triggers MCP stdio server; no special transport flag needed |
| CLI flags | `--mcp` — run as MCP server; subcommands: `search`, `analyze`, `errors`, `find-usage`, `setup` |

### Runtime dependencies

| Package | Version constraint |
|---|---|
| @modelcontextprotocol/sdk | ^1.17.2 |
| chalk | ^5.3.0 |
| chokidar | ^4.0.3 |
| commander | ^14.0.0 |
| tree-sitter | ^0.21.1 |
| tree-sitter-c | ^0.21.0 |
| tree-sitter-c-sharp | ^0.21.3 |
| tree-sitter-cpp | ^0.21.0 |
| tree-sitter-go | ^0.21.0 |
| tree-sitter-html | ^0.23.2 |
| tree-sitter-java | ^0.21.0 |
| tree-sitter-javascript | ^0.21.0 |
| tree-sitter-kotlin | ^0.3.8 |
| tree-sitter-php | ^0.23.12 |
| tree-sitter-python | ^0.21.0 |
| tree-sitter-ruby | ^0.21.0 |
| tree-sitter-rust | ^0.21.0 |
| tree-sitter-typescript | ^0.21.0 |

### MCP tools provided

The server exposes 4 tools over MCP:

- `search_code` — search for functions, classes, variables with fuzzy matching
- `find_usage` — find all usages of an identifier across the codebase
- `analyze_code` — analyze code quality, structure, dead code, and configuration issues
- `check_errors` — find actionable syntax errors with context and fix suggestions

### MCP resources

- `analysis://<path>` — returns full analysis report for a project directory

## Packaging notes

- The package is **not published to npm** — fetch source from GitHub with `fetchFromGitHub`.
- Native tree-sitter grammars (C, C++, Go, Java, etc.) contain `.node` native addons that
  require `node-gyp` at build time. The Nix derivation needs `python3`, `gcc`, and
  `node-gyp` available during the npm install phase.
- Use `buildNpmPackage` with `npmDepsHash` for reproducible builds.
- The `--mcp` flag or piped stdin (non-TTY) starts the stdio MCP server — use `--mcp`
  in `claude-with-servers` for explicit invocation.
- License is **GPL-3.0** (not MIT) — verify this is acceptable for the toolbelt's
  licensing requirements.

## Standalone use

```nix
{
  inputs.codebase.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/codebase";

  outputs = { self, nixpkgs, flake-utils, codebase }:
    flake-utils.lib.eachDefaultSystem (system: {
      devShells.default = nixpkgs.legacyPackages.${system}.mkShell {
        packages = [ codebase.packages.${system}.tree-sitter-mcp ];
      };
    });
}
```
