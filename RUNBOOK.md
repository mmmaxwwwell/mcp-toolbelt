# mcp-toolbelt Implementation Runbook

This runbook covers packaging each MCP server into the toolbelt. It's designed
to be followed by either a human or an AI agent, one server at a time.

## The pattern

Every server follows the same structure established by `servers/code-graph/`:

```
servers/<name>/
├── flake.nix        # Nix flake that builds the upstream package
├── flake.lock       # Pinned dependencies
└── README.md        # What it does, how to use standalone, how to bump
```

The root `flake.nix` imports each server as a path input and re-exports its
packages. The `scripts/claude-with-servers` script auto-detects which server
binaries are on PATH and generates the merged `.mcp.json`.

## Testing strategy

Three levels per server, all automated in `tests/`:

### Level 1: Build test
Does `nix build .#<package>` succeed?

```bash
nix build .#<package-name> --no-link
echo $?  # must be 0
```

### Level 2: MCP protocol smoke test
Does the server speak MCP? Send `initialize` over stdio, expect a valid response.

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  | timeout 10 <server-binary> 2>/dev/null \
  | head -1 \
  | jq -e '.result.protocolVersion'
```

### Level 3: Tool listing test
Does the server expose the expected tools?

```bash
# After initialize, send tools/list
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | timeout 10 <server-binary> 2>/dev/null \
  | tail -1 \
  | jq -e '.result.tools | length > 0'
```

### Integration test
Does `claude-with-servers` generate a valid `.mcp.json` with all available servers?

```bash
MCP_TOOLBELT_PROJECT_DIR=$(mktemp -d) claude-with-servers --dry-run 2>/dev/null
jq -e '.mcpServers | keys | length > 0' "$MCP_TOOLBELT_PROJECT_DIR/.mcp-toolbelt/mcp.json"
```

## Server implementation checklist

Use this checklist for each server. Order doesn't matter — servers are
independent. Recommended priority (easiest/most value first):

1. `git-guard` (mcp-server-git) — Python, pip, well-established
2. `codebase` (tree-sitter-mcp) — TypeScript, npm
3. `web-browser` (fetcher-mcp + sidecar) — TypeScript, npm, needs Playwright Chromium
4. `web-search` (pskill9/web-search) — TypeScript, npm
4. `task-runner` (shell-mcp) — Rust, cargo
5. `test-runner` (mcp-test-runner) — check upstream language/build
6. `edit-surface` (mcp-contextual-code-edit) — newer, may need more work
7. `sqlite-store` (sqlite-memory-mcp) — check upstream language/build

### Per-server steps

#### Step 1: Research the upstream

Before writing any Nix, understand the upstream package:

- [ ] Clone or browse the upstream repo
- [ ] Identify the language and build system (pip, npm, cargo, go)
- [ ] Find the latest tagged release (pin to a tag, not main)
- [ ] Identify the entry point binary name
- [ ] Check runtime dependencies (does it need Playwright browsers? a database?)
- [ ] Note any CLI flags needed for stdio MCP mode (some servers default to HTTP)
- [ ] Check the license

Record findings in `servers/<name>/README.md`.

#### Step 2: Write the flake

Create `servers/<name>/flake.nix`. Use the appropriate Nix builder:

- **Python (pip):** `python3Packages.buildPythonApplication` — see `servers/code-graph/flake.nix` for the pattern
- **TypeScript (npm):** `buildNpmPackage` or `mkDerivation` with `nodejs` + `npm install --production`
- **Rust (cargo):** `rustPlatform.buildRustPackage`
- **Go:** `buildGoModule`

The flake must:
- Pin to a specific upstream release tag + content hash
- Export `packages.default` = the server binary
- Export `packages.<name>` = same, for explicit reference
- Include `meta` with description, homepage, license, mainProgram
- Pass `doCheck = false` if upstream tests require network/fixtures

#### Step 3: Verify the build

```bash
cd servers/<name>
nix build
./result/bin/<binary> --help  # or --version, sanity check
```

#### Step 4: Run the MCP smoke test

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  | timeout 10 ./result/bin/<binary> 2>/dev/null \
  | head -1 \
  | jq -e '.result.protocolVersion'
```

If it fails:
- Check if the server needs specific CLI flags (e.g., `--stdio`, `serve --transport stdio`)
- Check if it needs a working directory or config file
- Check stderr for error messages: `echo '...' | ./result/bin/<binary> 2>&1`

#### Step 5: Record expected tools

Run `tools/list` and save the expected tool names:

```bash
printf '..initialize..\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | timeout 10 ./result/bin/<binary> 2>/dev/null \
  | tail -1 \
  | jq '.result.tools[].name'
```

Save this list in `servers/<name>/README.md` under "MCP tools the agent gets".

#### Step 6: Wire into root flake

In the root `flake.nix`:

1. Add the input:
   ```nix
   <name>.url = "path:./servers/<name>";
   <name>.inputs.nixpkgs.follows = "nixpkgs";
   <name>.inputs.flake-utils.follows = "flake-utils";
   ```

2. Add to `packages`:
   ```nix
   <name> = <name-input>.packages.${system}.default;
   ```

3. Add to `devShells.default.packages`.

#### Step 7: Wire into claude-with-servers

In `scripts/claude-with-servers`, add a block for the new server following the
existing pattern. Key things to get right:

- The binary name to check with `command -v`
- The env var toggle name (`MCP_TOOLBELT_<NAME>`)
- The correct CLI args (especially `--repository`, `--project-dir`, etc.)
- The JSON key name in `.mcp.json`

#### Step 8: Write the test

Create `tests/<name>.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

BINARY="${1:-<name>}"

echo "=== Build test ==="
command -v "$BINARY" || { echo "FAIL: $BINARY not on PATH"; exit 1; }

echo "=== MCP initialize test ==="
RESP=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  | timeout 10 "$BINARY" 2>/dev/null | head -1)
echo "$RESP" | jq -e '.result.protocolVersion' || { echo "FAIL: bad initialize response"; exit 1; }

echo "=== Tool listing test ==="
TOOLS=$(printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | timeout 10 "$BINARY" 2>/dev/null | tail -1)
TOOL_COUNT=$(echo "$TOOLS" | jq '.result.tools | length')
echo "Found $TOOL_COUNT tools"
[ "$TOOL_COUNT" -gt 0 ] || { echo "FAIL: no tools found"; exit 1; }

echo "=== ALL PASSED ==="
```

#### Step 9: Update root README

Add the server to the "Server catalog" table in `README.md`, changing status
from "planned" to "packaged".

#### Step 10: Commit

One commit per server:

```
feat(servers/<name>): package <upstream-repo> as <name> MCP server

Nix flake packaging <upstream> v<version> for the mcp-toolbelt.
Provides <brief description of what tools it exposes>.
Wired into root flake and claude-with-servers launcher.
```

## Troubleshooting

### npm packages that need native modules
Use `buildNpmPackage` with `npmDepsHash`. If native modules fail, check if
`node-gyp` needs `python3`, `pkg-config`, or system libraries.

### Python packages with relaxed version bounds
Use `pythonRelaxDeps` (see code-graph for example). Common for packages that
pin `<2` when nixpkgs has `2.x`.

### Servers that need Playwright browsers
The `web-browser` slot wraps `fetcher-mcp`, which needs Chromium for JS
rendering. Use `pkgs.playwright-driver.browsers` and set
`PLAYWRIGHT_BROWSERS_PATH` + `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in a
`makeWrapper` script around the bundled fetcher-mcp binary. This is the
hardest server to package — expect iteration.

### Sidecar MCP servers
`web-browser` is a sidecar: it speaks MCP to the agent and spawns
`fetcher-mcp` as a child over stdio. The sidecar passes fetch calls through,
captures the response, writes extracted markdown to SQLite FTS5, then
returns the response unchanged. Use this pattern when you want to *augment*
an upstream server without forking it. Key implementation notes: forward
`initialize`/`tools/list` directly (concatenating our added tools onto the
upstream's list), match request IDs round-trip, and surface upstream errors
verbatim so debugging stays simple.

### Servers that default to HTTP instead of stdio
Many servers start an HTTP server by default. Look for `--stdio`, `--transport stdio`,
or `serve` subcommands. The MCP config in `.mcp.json` uses stdio transport.

### Hash mismatches on nix build
When pinning a new version, use `lib.fakeHash` first, then copy the correct
hash from the error message.

## Post-implementation

After all servers are packaged:

1. Add a `nix flake check` that runs all `tests/*.sh`
2. Add CI (GitHub Actions) that builds all servers on push
3. Add Renovate/Dependabot config to track upstream releases
4. Write a `CLAUDE.md` for this repo so agents working on the toolbelt
   itself use these servers (dogfooding)
