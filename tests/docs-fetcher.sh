#!/usr/bin/env bash
# tests/docs-fetcher.sh — MCP smoke tests for docs-fetcher.
# Verifies build, MCP initialize, tools/list, and the expected tool surface.
#
# docs-fetcher doesn't exit on stdin EOF (holds the child fetcher-mcp process
# open), so `timeout` returns 124 even after a successful response. We wrap
# the pipeline in `|| true` to tolerate this — we only care that the JSON
# we wanted came back.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

BINARY="docs-fetcher"

if ! command -v "$BINARY" >/dev/null 2>&1; then
  echo "SKIP: $BINARY not on PATH"
  exit 0
fi

# Use a temp XDG_CACHE_HOME so we don't pollute the user cache.
export XDG_CACHE_HOME="$(mktemp -d)"
trap 'rm -rf "$XDG_CACHE_HOME"' EXIT

mcp_build_test "$BINARY"

# Level 2: initialize — tolerate timeout exit 124.
echo "=== MCP initialize test: $BINARY ==="
resp=$(echo "$MCP_INITIALIZE_REQUEST" \
  | { timeout 10 "$BINARY" 2>/dev/null || true; } \
  | head -1 || true)
if [ -z "$resp" ]; then
  echo "FAIL: no response from $BINARY"
  exit 1
fi
echo "$resp" | jq -e '.result.protocolVersion' >/dev/null 2>&1 || {
  echo "FAIL: bad initialize response: $resp"
  exit 1
}
echo "PASS: initialize returned protocolVersion=$(echo "$resp" | jq -r '.result.protocolVersion')"

# Level 3: tools/list — same tolerance.
echo "=== Tool listing test: $BINARY ==="
tools_resp=$(printf '%s\n%s\n' \
  "$MCP_INITIALIZE_REQUEST" \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | { timeout 10 "$BINARY" 2>/dev/null || true; } \
  | tail -1 || true)
if [ -z "$tools_resp" ]; then
  echo "FAIL: no tools/list response"
  exit 1
fi
tool_count=$(echo "$tools_resp" | jq -r '.result.tools | length' 2>/dev/null || echo 0)
if [ "$tool_count" -lt 1 ]; then
  echo "FAIL: expected >0 tools, got $tool_count"
  exit 1
fi
echo "PASS: found $tool_count tools"

# Expected tool surface.
actual_tools=$(echo "$tools_resp" | jq -r '.result.tools[].name' | tr '\n' ' ')
for want in list_manifests list_deps warm_docs search list_indexed get_section purge; do
  echo " $actual_tools " | grep -q " $want " || {
    echo "FAIL: expected tool '$want' missing. Actual: $actual_tools"
    exit 1
  }
done
echo "PASS: all expected tools present"

echo "=== ALL PASSED: $BINARY ==="
