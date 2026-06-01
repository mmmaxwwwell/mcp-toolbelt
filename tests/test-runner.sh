#!/usr/bin/env bash
# tests/test-runner.sh — MCP smoke tests for mcp-test-runner (test-runner)
# Verifies build, MCP initialize, and tools/list.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

mcp_smoke_test "mcp-test-runner"
