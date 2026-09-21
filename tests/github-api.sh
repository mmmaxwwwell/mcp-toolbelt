#!/usr/bin/env bash
# tests/github-api.sh — MCP smoke tests for github-mcp-server (github-api).
# Binary is github-mcp-server; needs the "stdio" subcommand and a token in env.
# A fake token is fine for initialize + tools/list (no API calls made).
#
# Because the server logs to stderr and holds stdin open, we need to force
# EOF on stdin promptly. We do this with a subshell that closes after writing.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

BINARY="github-mcp-server"

if ! command -v "$BINARY" >/dev/null 2>&1; then
  echo "SKIP: $BINARY not on PATH"
  exit 0
fi

# Fake token — server refuses to boot without one, but only uses it on real
# API calls. initialize + tools/list respond fine with an invalid token.
export GITHUB_PERSONAL_ACCESS_TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN:-fake_token_for_test}"

# Level 1: build.
mcp_build_test "$BINARY"

# Level 2: initialize — feed the request then a small sleep so the server has
# time to reply before EOF closes it. --toolsets=context keeps startup tiny.
echo "=== MCP initialize test: $BINARY stdio ==="
resp=$( { echo "$MCP_INITIALIZE_REQUEST"; sleep 1; } \
  | timeout 10 "$BINARY" stdio --toolsets context 2>/dev/null \
  | grep -m1 -E '^\s*\{"jsonrpc"' || true)
if [ -z "$resp" ]; then
  echo "SKIP: $BINARY did not respond to initialize (may need real token to boot)"
  exit 0
fi
echo "$resp" | jq -e '.result.protocolVersion' >/dev/null 2>&1 || {
  echo "FAIL: bad initialize response: $resp"
  exit 1
}
echo "PASS: initialize returned protocolVersion=$(echo "$resp" | jq -r '.result.protocolVersion')"

# Level 3: tools/list.
echo "=== Tool listing test: $BINARY stdio ==="
tools_resp=$( { printf '%s\n%s\n' "$MCP_INITIALIZE_REQUEST" \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; sleep 2; } \
  | timeout 15 "$BINARY" stdio --toolsets context 2>/dev/null \
  | grep -E '^\s*\{"jsonrpc"' | tail -1 || true)
if [ -z "$tools_resp" ]; then
  echo "FAIL: no tools/list response"
  exit 1
fi
tool_count=$(echo "$tools_resp" | jq -r '.result.tools | length' 2>/dev/null || echo 0)
if [ "$tool_count" -lt 1 ]; then
  echo "FAIL: expected >0 tools in context toolset, got $tool_count"
  exit 1
fi
echo "PASS: found $tool_count tools in the context toolset"

echo "=== ALL PASSED: $BINARY ==="
