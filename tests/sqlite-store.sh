#!/usr/bin/env bash
# tests/sqlite-store.sh — MCP smoke tests for sqlite-memory-mcp (sqlite-store)
# Verifies build, MCP initialize, and tools/list.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

# sqlite-memory-mcp uses fastmcp stdio transport — no special flags needed.
mcp_smoke_test "sqlite-memory-mcp"
