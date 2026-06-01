#!/usr/bin/env bash
# tests/web-browser.sh — MCP smoke + sidecar contract tests for web-browser
#
# Levels 1-3: build, initialize, tools/list (standard MCP smoke)
# Level 4: sidecar contract — fetch → cache → search → get → purge round-trip
#
# Uses a temporary XDG_CACHE_HOME so tests don't pollute the user cache.

set -euo pipefail

source "$(dirname "$0")/lib.sh"

BINARY="web-browser-sidecar"

# ── Temp environment ──
export XDG_CACHE_HOME="$(mktemp -d)"
PORT_FILE="$(mktemp)"
HTTP_PID=""
_SIDECAR_PID=""

cleanup() {
  [ -n "$_SIDECAR_PID" ] && kill "$_SIDECAR_PID" 2>/dev/null || true
  [ -n "$HTTP_PID" ] && kill "$HTTP_PID" 2>/dev/null || true
  rm -rf "$XDG_CACHE_HOME" "$PORT_FILE"
}
trap cleanup EXIT

DB_PATH="$XDG_CACHE_HOME/mcp-toolbelt/web-cache.db"

# ── Level 1: Build test ──
mcp_build_test "$BINARY"

# ── Fixture HTTP server ──
# Serves a small HTML page with a unique marker for FTS verification.
python3 << PYEOF &
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<html><head><title>MCP Toolbelt Test</title></head>"
                         b"<body><h1>MCP Toolbelt Test</h1>"
                         b"<p>Unique marker xyzzymcptest9f3a for FTS verification.</p>"
                         b"</body></html>")
    def log_message(self, *a): pass
with socketserver.TCPServer(("127.0.0.1", 0), H) as s:
    open("$PORT_FILE", "w").write(str(s.server_address[1]))
    s.serve_forever()
PYEOF
HTTP_PID=$!
sleep 1
HTTP_PORT=$(cat "$PORT_FILE")
FIXTURE_URL="http://127.0.0.1:${HTTP_PORT}/test-page"
echo "INFO: fixture HTTP server on port $HTTP_PORT"

# ── Start sidecar as coproc for interactive session ──
coproc SIDECAR { exec "$BINARY" 2>/dev/null; }
_SIDECAR_PID=$SIDECAR_PID

# Send a JSON-RPC message and read one response line.
mcp_call() {
  echo "$1" >&"${SIDECAR[1]}"
  local line
  read -r -t 60 line <&"${SIDECAR[0]}"
  echo "$line"
}

# ── Level 2: MCP initialize ──
echo "=== MCP initialize test: $BINARY ==="
init_resp=$(mcp_call "$MCP_INITIALIZE_REQUEST")
echo "$init_resp" | jq -e '.result.protocolVersion' >/dev/null 2>&1 || {
  echo "FAIL: bad initialize response: $init_resp"
  exit 1
}
echo "PASS: initialize returned protocolVersion=$(echo "$init_resp" | jq -r '.result.protocolVersion')"

# ── Level 3: tools/list ──
echo "=== Tool listing test: $BINARY ==="
tools_resp=$(mcp_call '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')

# Verify all 4 sidecar tools are present
for t in search_cached get_cached list_cached purge_cached; do
  echo "$tools_resp" | jq -e ".result.tools[] | select(.name == \"$t\")" >/dev/null 2>&1 || {
    echo "FAIL: sidecar tool '$t' not found in tools/list"
    exit 1
  }
done

# Verify upstream tools are also present (total > 4)
tool_count=$(echo "$tools_resp" | jq '.result.tools | length')
if [ "$tool_count" -le 4 ]; then
  echo "FAIL: expected upstream tools + 4 sidecar tools, only found $tool_count"
  exit 1
fi
echo "PASS: found $tool_count tools (upstream + 4 sidecar tools present)"

# Discover the upstream fetch tool name (first tool not in our sidecar set)
FETCH_TOOL=$(echo "$tools_resp" | jq -r \
  '[.result.tools[].name] - ["search_cached","get_cached","list_cached","purge_cached"] | .[0]')
echo "INFO: upstream fetch tool: $FETCH_TOOL"

# ── Level 4: Sidecar contract tests ──
echo "=== Sidecar contract tests ==="

# (a) Call upstream fetch tool against fixture URL
echo "--- (a) fetch via upstream tool ---"
fetch_req=$(jq -nc --arg t "$FETCH_TOOL" --arg u "$FIXTURE_URL" \
  '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":$t,"arguments":{"url":$u}}}')
fetch_resp=$(mcp_call "$fetch_req")
fetch_text=$(echo "$fetch_resp" | jq -r '.result.content[0].text // empty')
if [ -z "$fetch_text" ]; then
  echo "FAIL: fetch returned no content: $fetch_resp"
  exit 1
fi
echo "$fetch_text" | grep -q "xyzzymcptest9f3a" || {
  echo "FAIL: fetched markdown missing expected marker"
  echo "Got: $fetch_text"
  exit 1
}
echo "PASS: upstream fetch returned markdown with expected marker"

# Verify a row appeared in the DB via list_cached
list_req='{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"list_cached","arguments":{}}}'
list_resp=$(mcp_call "$list_req")
list_text=$(echo "$list_resp" | jq -r '.result.content[0].text')
echo "$list_text" | grep -q "127.0.0.1" || {
  echo "FAIL: list_cached doesn't show the fetched URL"
  echo "Got: $list_text"
  exit 1
}
echo "PASS: fetched page appears in cache (list_cached)"

# (b) search_cached for a term in the fetched markdown
echo "--- (b) search_cached ---"
search_req='{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"search_cached","arguments":{"query":"xyzzymcptest9f3a"}}}'
search_resp=$(mcp_call "$search_req")
search_text=$(echo "$search_resp" | jq -r '.result.content[0].text')
echo "$search_text" | grep -q "127.0.0.1" || {
  echo "FAIL: search_cached returned no hit for marker query"
  echo "Got: $search_text"
  exit 1
}
echo "PASS: search_cached found the fetched page"

# (c) get_cached for the fixture URL
echo "--- (c) get_cached ---"
get_req=$(jq -nc --arg u "$FIXTURE_URL" \
  '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"get_cached","arguments":{"url":$u}}}')
get_resp=$(mcp_call "$get_req")
get_text=$(echo "$get_resp" | jq -r '.result.content[0].text')
echo "$get_text" | grep -q "xyzzymcptest9f3a" || {
  echo "FAIL: get_cached markdown missing expected marker"
  echo "Got: $get_text"
  exit 1
}
echo "PASS: get_cached returned cached markdown with marker"

# (d) purge_cached and verify the row is gone
echo "--- (d) purge_cached ---"
purge_req=$(jq -nc --arg u "$FIXTURE_URL" \
  '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"purge_cached","arguments":{"url":$u}}}')
purge_resp=$(mcp_call "$purge_req")
echo "$purge_resp" | jq -e '.result.content[0].text' >/dev/null 2>&1 || {
  echo "FAIL: purge_cached returned no response"
  exit 1
}

# Verify the row is gone: get_cached should return isError
verify_req=$(jq -nc --arg u "$FIXTURE_URL" \
  '{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"get_cached","arguments":{"url":$u}}}')
verify_resp=$(mcp_call "$verify_req")
echo "$verify_resp" | jq -e '.result.isError' >/dev/null 2>&1 || {
  echo "FAIL: get_cached still returns data after purge"
  echo "Got: $verify_resp"
  exit 1
}
echo "PASS: purge_cached removed the cached page"

echo "=== ALL PASSED: $BINARY ==="
