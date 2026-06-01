#!/usr/bin/env bash
# tests/edit-surface.sh — MCP smoke tests for semantic-edit-mcp (edit-surface)
# Verifies build, MCP initialize, and tools/list.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

# semantic-edit-mcp requires the "serve" subcommand for MCP stdio mode.
mcp_smoke_test "semantic-edit-mcp" serve
