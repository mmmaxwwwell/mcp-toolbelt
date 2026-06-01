#!/usr/bin/env bash
# tests/git-guard.sh — MCP smoke tests for mcp-server-git (git-guard)
# Verifies build, MCP initialize, and tools/list.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

# mcp-server-git requires a git repository to operate on.
# Use the mcp-toolbelt repo itself (the repo root).
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mcp_smoke_test "mcp-server-git" --repository "$REPO_DIR"
