#!/usr/bin/env bash
# tests/task-runner.sh — MCP smoke tests for shell-mcp (task-runner)
# Verifies build, MCP initialize, and tools/list.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

# shell-mcp requires --root <path> to operate.
# Use the mcp-toolbelt repo root as the target.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mcp_smoke_test "shell-mcp" --root "$REPO_DIR"
