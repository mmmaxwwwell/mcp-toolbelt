# sqlite-store

Nix packaging for [`RMANOV/sqlite-memory-mcp`](https://github.com/RMANOV/sqlite-memory-mcp)
(pinned to tag `v3.12.0`) — a SQLite-backed MCP memory server providing a
persistent knowledge graph with WAL concurrent safety, FTS5 search, session
tracking, task management, and cross-machine bridge sync.

## Upstream research

| Field | Value |
|---|---|
| PyPI package | `sqlite-memory-mcp` (not published to PyPI — use `fetchFromGitHub`) |
| Version | **3.12.0** (tag `v3.12.0`, commit `1e21902`, 2026-06-01) |
| Repository | [RMANOV/sqlite-memory-mcp](https://github.com/RMANOV/sqlite-memory-mcp) |
| License | MIT (Copyright rmanov) |
| Language | Python (requires >=3.10) |
| Build system | setuptools >=61.0 (`pyproject.toml`, `setuptools.build_meta` backend) |
| Entry point | `sqlite-memory-mcp` console script → `server:main` |
| Stdio mode | Uses `fastmcp` with stdio transport — no special flags needed |
| MCP server name | `sqlite-kb` |
| Core MCP tools | 9 (knowledge-graph compatible with `@modelcontextprotocol/server-memory`) |

### Python dependencies

**Required:**

| Package | Version | Purpose |
|---|---|---|
| fastmcp | >=2.0.0 | MCP protocol handling (stdio transport) |

**Optional extras (not needed for core functionality):**

| Extra | Packages | Purpose |
|---|---|---|
| speed | orjson >=3.9.0 | Faster JSON serialization |
| vector | sqlite-vec >=0.1.6, sentence-transformers >=3.0.0 | Semantic vector search |
| gui | PyQt6 >=6.5 | Desktop task tray application |
| dev | pytest >=7.0 | Testing |

### Console script entry points

The package defines multiple entry points for domain-specific micro-servers:

| Binary | Purpose |
|---|---|
| `sqlite-memory-mcp` | **Primary entry point** — unified server (recommended) |
| `sqlite-memory-core` | Core knowledge-graph server only |
| `sqlite-memory-session` | Session tracking micro-server |
| `sqlite-memory-tasks` | Task management micro-server |
| `sqlite-memory-bridge` | Cross-machine sync micro-server |
| `sqlite-memory-collab` | Collaboration workflows micro-server |
| `sqlite-memory-entity` | Entity linking micro-server |
| `sqlite-memory-intel` | Intelligence/context assessment micro-server |
| `sqlite-memory-unified` | All-in-one alternative |
| `sqlite-memory-n8n` | n8n connector |
| `sqlite-memory-doctor` | Diagnostic tool |
| `sqlite-memory-debate-ops` | Debate operations |
| `sqlite-memory-demo` | Demo server |
| `task-tray` | System tray GUI (requires PyQt6) |
| `memory-digest` | Memory digest utility |

For Nix packaging, only `sqlite-memory-mcp` (the primary unified entry point)
is needed. The companion micro-servers are optional and can be exposed as
additional packages if desired.

### MCP tools (core server)

The core server (`sqlite-kb`) exposes 9 tools, drop-in compatible with the
official `@modelcontextprotocol/server-memory` knowledge-graph interface:

| Tool | Description |
|---|---|
| `create_entities` | Add entities to the knowledge graph |
| `add_observations` | Append observations to existing entities |
| `create_relations` | Establish typed relationships between entities |
| `delete_entities` | Remove entities (cascades observations + relations) |
| `delete_observations` | Remove specific observations from entities |
| `delete_relations` | Delete relationships between entities |
| `read_graph` | Retrieve the full knowledge graph (paginated) |
| `search_nodes` | Hybrid BM25 + semantic search via FTS5 |
| `open_nodes` | Access specific entities with their inter-relationships |

### Environment variables

| Variable | Purpose |
|---|---|
| `SQLITE_MEMORY_DB` | Database file path (default: `~/.claude/memory/memory.db`) |
| `BRIDGE_REPO` | Bridge sync repository path (optional, for cross-machine sync) |

### How it works

The server maintains a SQLite knowledge graph with entities, observations, and
relations. It uses WAL mode for concurrent access (10+ sessions can safely
read/write simultaneously). FTS5 powers keyword search with BM25 ranking, and
optional `sqlite-vec` enables semantic vector search with local embeddings.

The companion micro-servers (session, tasks, bridge, collab, entity, intel) add
domain-specific tools but are not required for the core memory functionality.
They are split into separate servers to stay within Claude Code's tool visibility
constraints.

## Packaging notes

- Written in Python — use `buildPythonApplication` with `fetchFromGitHub`.
- **Not published to PyPI** — must fetch from GitHub. The repo has
  `pyproject.toml` with setuptools backend.
- Pin to tag `v3.12.0` (commit `1e21902`, 2026-06-01).
- Only one required dependency: `fastmcp >=2.0.0`. The `fastmcp` package IS on
  PyPI and will need to be available as a Python package in nixpkgs or built
  separately.
- Uses Python stdlib `sqlite3` — no native SQLite compilation needed.
- No special flags for MCP stdio mode — just run `sqlite-memory-mcp` directly.
- Binary name for `meta.mainProgram`: `sqlite-memory-mcp`.
- The `sqlite3` module in Python requires SQLite >=3.38 for FTS5 support (should
  be satisfied by nixpkgs Python).

## Standalone use

```nix
{
  inputs.sqlite-store.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/sqlite-store";

  outputs = { self, nixpkgs, flake-utils, sqlite-store }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in
      {
        devShells.default = pkgs.mkShell {
          packages = [ sqlite-store.packages.${system}.default ];
        };
      });
}
```

## Composition

The `sqlite-store` slot gives the agent persistent memory across sessions via a
SQLite-backed knowledge graph. The agent can store entities, observations, and
relationships, then search them with FTS5 full-text search. Pairs with
`code-graph` (codebase structure awareness) and `edit-surface` (code
modifications informed by remembered context).
