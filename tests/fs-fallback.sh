#!/usr/bin/env bash
# tests/fs-fallback.sh — MCP smoke tests for fs-fallback.
# tools/list is fine without a config (server uses restrictive defaults);
# actual read/write calls are exercised in tests/scenarios/end-to-end.sh.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

BINARY="fs-fallback"

if ! command -v "$BINARY" >/dev/null 2>&1; then
  echo "SKIP: $BINARY not on PATH"
  exit 0
fi

# Isolate cwd so the restrictive defaults don't touch the toolbelt tree.
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
cd "$SCRATCH"

mcp_smoke_test "$BINARY"

# Expected core tool surface from the README.
mcp_expect_tools "$BINARY" \
  read_file read_file_range stat_file list_dir glob \
  write_file append_file delete_file recent_writes why_blocked

echo "=== ALL PASSED: $BINARY ==="
