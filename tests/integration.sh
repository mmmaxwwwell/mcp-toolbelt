#!/usr/bin/env bash
# tests/integration.sh — verify claude-with-servers generates valid .mcp.json
# Tests that the launcher detects all available servers on PATH and produces
# a well-formed MCP config file.
#
# Requirements: [FR-011, FR-012, SC-004]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Create an isolated temp directory for the test
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# Put a fake "claude" on PATH so claude-with-servers doesn't fail at exec.
# The stub just exits 0 — we only care about the config generation.
FAKE_BIN="$TEST_DIR/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$FAKE_BIN/claude"

export PATH="$FAKE_BIN:$PATH"
export MCP_TOOLBELT_PROJECT_DIR="$TEST_DIR/project"
mkdir -p "$MCP_TOOLBELT_PROJECT_DIR"

MCP_CONFIG="$MCP_TOOLBELT_PROJECT_DIR/.mcp-toolbelt/mcp.json"

echo "=== Integration test: claude-with-servers ==="

# Step 1: Verify claude-with-servers is on PATH
command -v claude-with-servers >/dev/null 2>&1 || {
  echo "FAIL: claude-with-servers not on PATH"
  exit 1
}
echo "PASS: claude-with-servers found at $(command -v claude-with-servers)"

# Step 2: Run claude-with-servers — it generates the config then exec's our stub claude
claude-with-servers 2>/dev/null || {
  echo "FAIL: claude-with-servers exited non-zero"
  exit 1
}
echo "PASS: claude-with-servers exited 0"

# Step 3: Verify the config file was created
if [ ! -f "$MCP_CONFIG" ]; then
  echo "FAIL: $MCP_CONFIG not created"
  exit 1
fi
echo "PASS: config file exists at $MCP_CONFIG"

# Step 4: Verify the config is valid JSON with the expected structure
jq -e '.mcpServers' "$MCP_CONFIG" >/dev/null 2>&1 || {
  echo "FAIL: config missing .mcpServers key or invalid JSON"
  echo "Content: $(cat "$MCP_CONFIG")"
  exit 1
}
echo "PASS: config has .mcpServers key"

# Step 5: Verify at least one server was detected
SERVER_COUNT=$(jq '.mcpServers | keys | length' "$MCP_CONFIG")
if [ "$SERVER_COUNT" -lt 1 ]; then
  echo "FAIL: no servers in config (expected at least 1)"
  exit 1
fi
echo "PASS: config has $SERVER_COUNT server(s)"

# Step 6: Verify each server entry has required fields (command + args)
INVALID=$(jq -r '
  .mcpServers | to_entries[]
  | select(.value.command == null or .value.args == null)
  | .key
' "$MCP_CONFIG")
if [ -n "$INVALID" ]; then
  echo "FAIL: servers missing command/args: $INVALID"
  exit 1
fi
echo "PASS: all server entries have command and args"

# Step 7: List detected servers for visibility
echo "--- Detected servers ---"
jq -r '.mcpServers | to_entries[] | "  \(.key): \(.value.command) \(.value.args | join(" "))"' "$MCP_CONFIG"
echo "------------------------"

echo "=== ALL PASSED ==="
