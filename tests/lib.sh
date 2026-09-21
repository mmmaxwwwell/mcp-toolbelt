#!/usr/bin/env bash
# tests/lib.sh — shared MCP smoke test functions for mcp-toolbelt
# Source this file from per-server test scripts.
#
# Usage:
#   source "$(dirname "$0")/lib.sh"
#   mcp_build_test "server-binary"
#   mcp_initialize_test "server-binary"
#   mcp_tools_list_test "server-binary"

set -euo pipefail

# The JSON-RPC initialize request used across all MCP tests.
MCP_INITIALIZE_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}'

# Level 1: Build test — verify the server binary is on PATH.
mcp_build_test() {
  local binary="$1"
  echo "=== Build test: $binary ==="
  command -v "$binary" >/dev/null 2>&1 || {
    echo "FAIL: $binary not on PATH"
    return 1
  }
  echo "PASS: $binary found at $(command -v "$binary")"
}

# Level 2: MCP initialize test — send initialize over stdio, expect a valid response.
mcp_initialize_test() {
  local binary="$1"
  shift
  # Any remaining args are passed to the binary (e.g. --stdio, --repository .)
  echo "=== MCP initialize test: $binary $* ==="
  local resp
  resp=$(echo "$MCP_INITIALIZE_REQUEST" \
    | timeout 10 "$binary" "$@" 2>/dev/null \
    | head -1)
  if [ -z "$resp" ]; then
    echo "FAIL: no response from $binary"
    return 1
  fi
  echo "$resp" | jq -e '.result.protocolVersion' >/dev/null 2>&1 || {
    echo "FAIL: bad initialize response: $resp"
    return 1
  }
  echo "PASS: initialize returned protocolVersion=$(echo "$resp" | jq -r '.result.protocolVersion')"
}

# Level 3: Tool listing test — send initialize + tools/list, verify tools are exposed.
mcp_tools_list_test() {
  local binary="$1"
  shift
  echo "=== Tool listing test: $binary $* ==="
  local tools_resp
  tools_resp=$(printf '%s\n%s\n' \
    "$MCP_INITIALIZE_REQUEST" \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    | timeout 10 "$binary" "$@" 2>/dev/null \
    | tail -1)
  if [ -z "$tools_resp" ]; then
    echo "FAIL: no tools/list response from $binary"
    return 1
  fi
  local tool_count
  tool_count=$(echo "$tools_resp" | jq -r '.result.tools | length' 2>/dev/null) || {
    echo "FAIL: bad tools/list response: $tools_resp"
    return 1
  }
  if [ "$tool_count" -gt 0 ] 2>/dev/null; then
    echo "PASS: found $tool_count tools"
  else
    echo "FAIL: no tools found (count=$tool_count)"
    return 1
  fi
}

# Convenience: run all 3 levels for a server binary.
mcp_smoke_test() {
  local binary="$1"
  shift
  mcp_build_test "$binary"
  mcp_initialize_test "$binary" "$@"
  mcp_tools_list_test "$binary" "$@"
  echo "=== ALL PASSED: $binary ==="
}

# Assert that named tools appear in tools/list response.
# Usage: mcp_expect_tools <binary> <tool1> [tool2 ...]
# Any extra flags to the binary must be baked into a wrapper, or supplied via
# MCP_EXPECT_TOOLS_EXTRA_ARGS env var (space-separated).
mcp_expect_tools() {
  local binary="$1"; shift
  local expected=("$@")
  local extra_args=()
  if [ -n "${MCP_EXPECT_TOOLS_EXTRA_ARGS:-}" ]; then
    # shellcheck disable=SC2206
    extra_args=( ${MCP_EXPECT_TOOLS_EXTRA_ARGS} )
  fi
  echo "=== Expect tools test: $binary (${expected[*]}) ==="
  local raw
  raw=$(printf '%s\n%s\n' \
    "$MCP_INITIALIZE_REQUEST" \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    | timeout 10 "$binary" "${extra_args[@]}" 2>/dev/null || true)
  if [ -z "$raw" ]; then
    echo "FAIL: no output from $binary"
    return 1
  fi
  # Filter to only JSON lines (some servers log to stdout).
  local resp
  resp=$(echo "$raw" | grep -E '^\s*\{' | while IFS= read -r line; do
    if echo "$line" | jq -e '.id == 2 and (.result.tools // empty)' >/dev/null 2>&1; then
      echo "$line"
      break
    fi
  done)
  if [ -z "$resp" ]; then
    echo "FAIL: no tools/list response with id=2 found"
    echo "Raw output was: $(echo "$raw" | head -c 500)"
    return 1
  fi
  local actual
  actual=$(echo "$resp" | jq -r '.result.tools[].name' 2>/dev/null | tr '\n' ' ')
  local missing=()
  for want in "${expected[@]}"; do
    if ! echo " $actual " | grep -q " $want "; then
      missing+=("$want")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "FAIL: missing expected tools: ${missing[*]}"
    echo "Actual tools: $actual"
    return 1
  fi
  echo "PASS: all ${#expected[@]} expected tools present"
}

# Send initialize + tools/call and echo the response body.
# Usage: mcp_call_tool <binary> <tool-name> <args-json> [-- extra binary args...]
# Callers pipe stdout to jq for their own assertions.
mcp_call_tool() {
  local binary="$1"; shift
  local tool_name="$1"; shift
  local args_json="$1"; shift
  # Any remaining args go to the binary
  local call_req
  call_req=$(jq -nc --arg n "$tool_name" --argjson a "$args_json" \
    '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:$n,arguments:$a}}')
  local raw
  raw=$(printf '%s\n%s\n' "$MCP_INITIALIZE_REQUEST" "$call_req" \
    | timeout 30 "$binary" "$@" 2>/dev/null || true)
  # Filter to JSON lines, pick the response with id=2.
  echo "$raw" | grep -E '^\s*\{' | while IFS= read -r line; do
    if echo "$line" | jq -e '.id == 2 and (.result // .error)' >/dev/null 2>&1; then
      echo "$line"
      break
    fi
  done
}
