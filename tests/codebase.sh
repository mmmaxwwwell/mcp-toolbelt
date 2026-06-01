#!/usr/bin/env bash
# tests/codebase.sh — MCP smoke tests for tree-sitter-mcp (codebase)
# Verifies build, MCP initialize, and tools/list.
#
# tree-sitter-mcp prints "[INFO] MCP server started successfully" to stdout
# before JSON-RPC responses, so we use custom handlers instead of
# mcp_smoke_test to filter non-JSON lines.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

BINARY="tree-sitter-mcp"

# Level 1: Build test (standard lib function)
mcp_build_test "$BINARY"

# Level 2: MCP initialize test — filter non-JSON lines
echo "=== MCP initialize test: $BINARY --mcp ==="
resp=$(echo "$MCP_INITIALIZE_REQUEST" \
  | timeout 10 "$BINARY" --mcp 2>/dev/null \
  | grep -m1 '^\s*{' || true)
if [ -z "$resp" ]; then
  echo "FAIL: no JSON response from $BINARY"
  exit 1
fi
echo "$resp" | jq -e '.result.protocolVersion' >/dev/null 2>&1 || {
  echo "FAIL: bad initialize response: $resp"
  exit 1
}
echo "PASS: initialize returned protocolVersion=$(echo "$resp" | jq -r '.result.protocolVersion')"

# Level 3: Tool listing test — send initialize + tools/list, grab last JSON line
echo "=== Tool listing test: $BINARY --mcp ==="
tools_resp=$(printf '%s\n%s\n' \
  "$MCP_INITIALIZE_REQUEST" \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | timeout 10 "$BINARY" --mcp 2>/dev/null \
  | grep '^\s*{' | tail -1)
if [ -z "$tools_resp" ]; then
  echo "FAIL: no tools/list response from $BINARY"
  exit 1
fi
tool_count=$(echo "$tools_resp" | jq -r '.result.tools | length' 2>/dev/null) || {
  echo "FAIL: bad tools/list response: $tools_resp"
  exit 1
}
if [ "$tool_count" -gt 0 ] 2>/dev/null; then
  echo "PASS: found $tool_count tools"
else
  echo "FAIL: no tools found (count=$tool_count)"
  exit 1
fi

echo "=== ALL PASSED: $BINARY ==="
