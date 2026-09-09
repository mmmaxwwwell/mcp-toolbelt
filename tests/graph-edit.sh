#!/usr/bin/env bash
# tests/graph-edit.sh — smoke tests for graph-edit MCP server
# Verifies build, MCP initialize, tools/list count, and expected tool names.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

# Level 1-3: standard smoke test (build + initialize + tools/list).
mcp_smoke_test "graph-edit"

# Verify tool count and specific tools.
echo "=== Tool count + expected-tools test: graph-edit ==="
tools_resp=$(printf '%s\n%s\n' \
  "$MCP_INITIALIZE_REQUEST" \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | timeout 10 graph-edit 2>/dev/null | tail -1)

count=$(echo "$tools_resp" | jq -r '.result.tools | length' 2>/dev/null || echo "0")
if [ "$count" != "29" ]; then
  echo "FAIL: expected 29 tools, got $count"
  exit 1
fi
echo "PASS: 29 tools registered"

# Every tool from the v1 surface must be present.
EXPECTED_TOOLS=(
  list_symbols get_symbol get_references list_modules describe_module
  create_symbol add_method add_property edit_symbol_body edit_symbol_signature
  rename_symbol move_symbol delete_symbol
  add_import add_export add_decorator set_doc_comment
  preview preview_types commit discard reset_session session_summary
  open_symbol explore describe_change_zone similar_to find
  raw_edit_symbol
)
missing=()
for want in "${EXPECTED_TOOLS[@]}"; do
  if ! echo "$tools_resp" | jq -e --arg n "$want" '.result.tools[] | select(.name == $n)' >/dev/null 2>&1; then
    missing+=("$want")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "FAIL: missing expected tools: ${missing[*]}"
  exit 1
fi
echo "PASS: all ${#EXPECTED_TOOLS[@]} expected tools present"

echo "=== graph-edit smoke: ALL PASSED ==="
