#!/usr/bin/env bash
# tests/web-search.sh — MCP smoke tests for web-search (pskill9/web-search)
# Verifies build, MCP initialize, and tools/list.
# Live-network search assertions are skipped (flaky in CI due to Google rate limits).

set -euo pipefail

source "$(dirname "$0")/lib.sh"

mcp_smoke_test "web-search"
