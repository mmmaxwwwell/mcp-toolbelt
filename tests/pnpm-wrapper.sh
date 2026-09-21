#!/usr/bin/env bash
# tests/pnpm-wrapper.sh — MCP smoke tests for pnpm-wrapper.
# Requires bwrap on PATH at startup (server refuses to boot otherwise).
# Needs a package.json in cwd for cwd auto-detection to succeed.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

BINARY="pnpm-wrapper"

if ! command -v "$BINARY" >/dev/null 2>&1; then
  echo "SKIP: $BINARY not on PATH"
  exit 0
fi

if ! command -v bwrap >/dev/null 2>&1; then
  echo "SKIP: bwrap not on PATH — pnpm-wrapper refuses to start without it"
  exit 0
fi

# Sandbox: fresh scratch dir with a minimal package.json.
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
cat > "$SCRATCH/package.json" <<'EOF'
{ "name": "smoke-test", "packageManager": "pnpm@9.0.0",
  "scripts": { "test": "echo smoke-test-ok", "lint": "echo lint-ok" } }
EOF
touch "$SCRATCH/pnpm-lock.yaml"

mcp_build_test "$BINARY"

cd "$SCRATCH"
mcp_initialize_test "$BINARY"
mcp_tools_list_test "$BINARY"

# Expected tool surface (subset — see README for all 17).
mcp_expect_tools "$BINARY" \
  add remove update list why outdated run list_scripts test lint \
  typecheck install install_frozen prune audit licenses describe_sandbox

echo "=== ALL PASSED: $BINARY ==="
