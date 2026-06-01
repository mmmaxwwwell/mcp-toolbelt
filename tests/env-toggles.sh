#!/usr/bin/env bash
# tests/env-toggles.sh — verify MCP_TOOLBELT_<NAME>=0 excludes servers from .mcp.json
# For each server, sets its toggle env var to 0 and checks the server key is absent.
#
# Requirements: [FR-013, SC-005]
set -euo pipefail

# Create an isolated temp directory for the test
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# Put a fake "claude" on PATH so claude-with-servers doesn't fail at exec.
FAKE_BIN="$TEST_DIR/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$FAKE_BIN/claude"

export PATH="$FAKE_BIN:$PATH"

echo "=== Env-toggle test: MCP_TOOLBELT_<NAME>=0 ==="

# Verify claude-with-servers is on PATH
command -v claude-with-servers >/dev/null 2>&1 || {
  echo "FAIL: claude-with-servers not on PATH"
  exit 1
}

# Map: env_var server_key
# Each line is "ENV_VAR SERVER_KEY" — the env var that disables the server,
# and the key that should be absent from .mcpServers when disabled.
TOGGLES=(
  "MCP_TOOLBELT_CODE_GRAPH code-review-graph"
  "MCP_TOOLBELT_CODEBASE tree-sitter-mcp"
  "MCP_TOOLBELT_WEB_BROWSER web-browser"
  "MCP_TOOLBELT_GIT_GUARD mcp-server-git"
  "MCP_TOOLBELT_WEB_SEARCH web-search"
  "MCP_TOOLBELT_TASK_RUNNER shell-mcp"
  "MCP_TOOLBELT_EDIT_SURFACE semantic-edit-mcp"
  "MCP_TOOLBELT_TEST_RUNNER mcp-test-runner"
  "MCP_TOOLBELT_SQLITE_STORE sqlite-store"
)

FAILURES=0

for entry in "${TOGGLES[@]}"; do
  env_var="${entry%% *}"
  server_key="${entry##* }"

  # Create a fresh project dir for each toggle test
  PROJECT="$TEST_DIR/project-${server_key}"
  mkdir -p "$PROJECT"

  # Run claude-with-servers with this toggle set to 0
  MCP_CONFIG="$PROJECT/.mcp-toolbelt/mcp.json"
  env MCP_TOOLBELT_PROJECT_DIR="$PROJECT" "${env_var}=0" claude-with-servers 2>/dev/null || true

  # Check if the config was created
  if [ ! -f "$MCP_CONFIG" ]; then
    echo "FAIL: [$env_var=0] config not created"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  # Verify the server key is absent from .mcpServers
  if jq -e --arg name "$server_key" '.mcpServers[$name]' "$MCP_CONFIG" >/dev/null 2>&1; then
    echo "FAIL: [$env_var=0] server '$server_key' still present in .mcp.json"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: [$env_var=0] server '$server_key' correctly absent"
  fi
done

if [ "$FAILURES" -gt 0 ]; then
  echo "=== FAILED: $FAILURES toggle(s) did not exclude their server ==="
  exit 1
fi

echo "=== ALL PASSED ==="
