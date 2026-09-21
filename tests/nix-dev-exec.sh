#!/usr/bin/env bash
# tests/nix-dev-exec.sh — MCP smoke tests for nix-dev-exec.
# Requires bwrap on PATH at startup (server refuses to boot otherwise).
# We fabricate a minimal .nix-dev-exec.toml so the registry loads cleanly.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

BINARY="nix-dev-exec"

if ! command -v "$BINARY" >/dev/null 2>&1; then
  echo "SKIP: $BINARY not on PATH"
  exit 0
fi

if ! command -v bwrap >/dev/null 2>&1; then
  echo "SKIP: bwrap not on PATH — nix-dev-exec refuses to start without it"
  exit 0
fi

# Sandbox: fresh scratch dir with a minimal registry.
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
cat > "$SCRATCH/.nix-dev-exec.toml" <<'EOF'
[operations.echo]
description = "Echo a marker string for smoke tests."
command     = "echo smoke-test-ok"
sandbox.preset = "strict"
EOF

# Level 1 (build): standard.
mcp_build_test "$BINARY"

# Level 2/3: run inside the scratch dir so the registry resolves.
cd "$SCRATCH"
mcp_initialize_test "$BINARY"
mcp_tools_list_test "$BINARY"

# Expected tool surface from the README.
mcp_expect_tools "$BINARY" \
  list_operations describe_operation dry_run run env_info which describe_sandbox recent_runs

echo "=== ALL PASSED: $BINARY ==="
