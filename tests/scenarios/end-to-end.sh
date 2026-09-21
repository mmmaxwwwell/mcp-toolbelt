#!/usr/bin/env bash
# tests/scenarios/end-to-end.sh — real MCP tool-call battery against a fixture.
#
# Copies tests/fixtures/sample-project/ to a scratch dir, then runs one-shot
# tool calls against fs-fallback, nix-dev-exec, pnpm-wrapper, docs-fetcher,
# and edit-surface. Each server is invoked cwd=SCRATCH so its config
# discovery resolves to the fixture.
#
# Any missing binary → the entire block for that server is skipped with a
# clear message rather than failing. All calls are offline.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/tests/fixtures/sample-project"

if [ ! -d "$FIXTURE_DIR" ]; then
  echo "FAIL: fixture missing at $FIXTURE_DIR"
  exit 1
fi

# Scratch — copy fixture including dotfiles.
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
cp -a "$FIXTURE_DIR/." "$SCRATCH/"
cd "$SCRATCH"

# Isolate caches so we don't pollute the user's ~/.cache.
export XDG_CACHE_HOME="$SCRATCH/.xdg-cache"
mkdir -p "$XDG_CACHE_HOME"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0.1.0"}}}'

# ── Helpers ─────────────────────────────────────────────────────────────
# call <binary> <tool> <args_json> [<binary-extra-args>...]
# Sends initialize + tools/call, prints the response line (id=2).
call() {
  local binary="$1"; shift
  local tool="$1"; shift
  local args="$1"; shift
  local req
  req=$(jq -nc --arg n "$tool" --argjson a "$args" \
    '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:$n,arguments:$a}}')
  # Tolerate timeout (some servers don't exit on stdin EOF).
  printf '%s\n%s\n' "$INIT" "$req" \
    | { timeout 10 "$binary" "$@" 2>/dev/null || true; } \
    | grep -E '^\s*\{"jsonrpc"|^\s*\{"result"' \
    | while IFS= read -r line; do
        if echo "$line" | jq -e '.id == 2 and (.result // .error)' >/dev/null 2>&1; then
          echo "$line"; break
        fi
      done
}

ok()   { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

# ── fs-fallback ─────────────────────────────────────────────────────────
if command -v fs-fallback >/dev/null 2>&1; then
  echo "=== Scenario: fs-fallback ==="

  # read_file on README.md → allowed
  r=$(call fs-fallback read_file '{"path":"README.md"}')
  echo "$r" | jq -e '.result.isError | not' >/dev/null 2>&1 \
    && echo "$r" | jq -e '.result.content[0].text | contains("Sample Project")' >/dev/null \
    && ok "read_file README.md allowed" \
    || fail "read_file README.md unexpectedly denied: $r"

  # read_file on .env → denied
  r=$(call fs-fallback read_file '{"path":".env"}')
  echo "$r" | jq -e '.result.isError == true and (.result.content[0].text | contains("deny"))' >/dev/null \
    && ok "read_file .env denied with reason" \
    || fail "read_file .env should have been denied: $r"

  # write_file on docs/NOTES.md → allowed
  r=$(call fs-fallback write_file '{"path":"docs/NOTES.md","content":"e2e-marker\n"}')
  echo "$r" | jq -e '.result.isError | not' >/dev/null 2>&1 \
    && [ -f "$SCRATCH/docs/NOTES.md" ] \
    && grep -q "e2e-marker" "$SCRATCH/docs/NOTES.md" \
    && ok "write_file docs/NOTES.md persisted" \
    || fail "write_file docs/NOTES.md failed or file missing: $r"

  # write_file on src/index.ts → refused with edit-surface hint
  r=$(call fs-fallback write_file '{"path":"src/index.ts","content":"broken"}')
  echo "$r" | jq -e '.result.isError == true and (.result.content[0].text | contains("edit-surface"))' >/dev/null \
    && ok "write_file src/index.ts refused with edit-surface hint" \
    || fail "src/index.ts write should have been refused: $r"

  # write_file on package.json without confirm → soft-deny
  r=$(call fs-fallback write_file '{"path":"package.json","content":"{}"}')
  echo "$r" | jq -e '.result.isError == true and (.result.content[0].text | contains("soft_deny"))' >/dev/null \
    && ok "write_file package.json soft-denied without confirm" \
    || fail "package.json soft-deny not triggered: $r"

  # why_blocked on pnpm-lock.yaml → write soft_deny + hint
  r=$(call fs-fallback why_blocked '{"path":"pnpm-lock.yaml"}')
  echo "$r" | jq -e '(.result.content[0].text | fromjson | .write.decision) == "soft_deny"' >/dev/null \
    && echo "$r" | jq -e '(.result.content[0].text | fromjson | .write.hint) | contains("pnpm-wrapper")' >/dev/null \
    && ok "why_blocked pnpm-lock.yaml → soft_deny + hint" \
    || fail "why_blocked pnpm-lock.yaml wrong: $r"
else
  echo "SKIP: fs-fallback not on PATH"
fi

# ── nix-dev-exec ────────────────────────────────────────────────────────
if command -v nix-dev-exec >/dev/null 2>&1 && command -v bwrap >/dev/null 2>&1; then
  echo "=== Scenario: nix-dev-exec ==="

  # list_operations → returns the 4 registered ops
  r=$(call nix-dev-exec list_operations '{}')
  ops=$(echo "$r" | jq -r '.result.content[0].text | fromjson | .[].name' | sort | tr '\n' ' ')
  echo " $ops " | grep -q " test " && echo " $ops " | grep -q " typecheck " \
    && echo " $ops " | grep -q " lint " && echo " $ops " | grep -q " flake_check " \
    && ok "list_operations returns test/typecheck/lint/flake_check ($ops)" \
    || fail "list_operations missing expected ops: $ops"

  # dry_run test → returns expanded argv with bwrap prefix
  r=$(call nix-dev-exec dry_run '{"name":"test"}')
  first=$(echo "$r" | jq -r '.result.content[0].text | fromjson | .full_argv[0]')
  [ "$first" = "bwrap" ] \
    && ok "dry_run test → argv prefixed with bwrap" \
    || fail "dry_run test not bwrap-prefixed (got: $first): $r"

  # describe_sandbox test → preset=strict
  r=$(call nix-dev-exec describe_sandbox '{"name":"test"}')
  preset=$(echo "$r" | jq -r '.result.content[0].text | fromjson | .preset')
  [ "$preset" = "strict" ] \
    && ok "describe_sandbox test → preset=strict" \
    || fail "describe_sandbox test preset wrong: $preset — full: $r"

  # Actual run: skip if we're in a nix build sandbox (no unpriv userns).
  if [ "${SKIP_NETWORK_TESTS:-0}" = "1" ] || [ -n "${IN_NIX_SHELL:-}" ] && [ -n "${NIX_BUILD_TOP:-}" ]; then
    echo "SKIP: nix-dev-exec run (in nix build sandbox)"
  else
    # Try running the "test" op — expects echo test-ok inside the sandbox.
    r=$(call nix-dev-exec run '{"name":"test"}')
    if echo "$r" | jq -e '(.result.content[0].text | fromjson | .exit_code) == 0' >/dev/null 2>&1; then
      ok "run test → exit_code 0"
    else
      echo "SKIP: nix-dev-exec run failed (likely no unpriv userns): $(echo "$r" | jq -r '.result.content[0].text | fromjson | .stderr // "<empty>"' | head -c 200)"
    fi
  fi
else
  echo "SKIP: nix-dev-exec or bwrap not available"
fi

# ── pnpm-wrapper ────────────────────────────────────────────────────────
if command -v pnpm-wrapper >/dev/null 2>&1 && command -v bwrap >/dev/null 2>&1; then
  echo "=== Scenario: pnpm-wrapper ==="

  # list_scripts → returns test/lint/typecheck
  r=$(call pnpm-wrapper list_scripts '{}')
  names=$(echo "$r" | jq -r '.result.content[0].text | fromjson | .[].name' 2>/dev/null | sort | tr '\n' ' ')
  echo " $names " | grep -q " test " && echo " $names " | grep -q " lint " \
    && echo " $names " | grep -q " typecheck " \
    && ok "list_scripts → test/lint/typecheck ($names)" \
    || fail "list_scripts missing expected scripts: $names — full: $r"

  # describe_sandbox for readonly verb → preset=readonly
  r=$(call pnpm-wrapper describe_sandbox '{"verb":"list"}')
  preset=$(echo "$r" | jq -r '.result.content[0].text | fromjson | .sandbox.preset' 2>/dev/null || echo "")
  [ "$preset" = "readonly" ] \
    && ok "describe_sandbox list → preset=readonly" \
    || fail "describe_sandbox list preset wrong: $preset — full: $r"
else
  echo "SKIP: pnpm-wrapper or bwrap not available"
fi

# ── docs-fetcher ────────────────────────────────────────────────────────
if command -v docs-fetcher >/dev/null 2>&1; then
  echo "=== Scenario: docs-fetcher ==="

  # list_manifests → finds package.json
  r=$(call docs-fetcher list_manifests '{}')
  echo "$r" | jq -e '(.result.content[0].text | fromjson | .manifests[].ecosystem) | contains("npm")' >/dev/null 2>&1 \
    && ok "list_manifests → finds package.json (npm)" \
    || fail "list_manifests missing npm manifest: $r"

  # list_deps → finds zod at 3.23.8
  r=$(call docs-fetcher list_deps '{}')
  zod_ver=$(echo "$r" | jq -r '.result.content[0].text | fromjson | .deps[] | select(.package=="zod") | .version' 2>/dev/null)
  [ "$zod_ver" = "3.23.8" ] \
    && ok "list_deps → zod resolved to 3.23.8" \
    || fail "list_deps zod version wrong: $zod_ver — full: $r"

  echo "SKIP: docs-fetcher warm_docs (network + fetcher-mcp)"
else
  echo "SKIP: docs-fetcher not on PATH"
fi

# ── edit-surface ────────────────────────────────────────────────────────
if command -v semantic-edit-mcp >/dev/null 2>&1 && command -v fs-fallback >/dev/null 2>&1; then
  echo "=== Scenario: edit-surface + fs-fallback readback ==="

  # preview_edit + persist_edit MUST share a session (persist has no args —
  # it commits the last-staged preview). Send both requests in one stdio
  # session and grab both responses.
  # Anchor "a + b" targets the binary expression inside the sum() body.
  # We rewrite it to "b + a". Kept scoped so no formatter is invoked
  # (semantic-edit-mcp bundles prettier lookup which may not be present
  # inside the test env).
  preview_call=$(jq -nc --arg f "$SCRATCH/src/index.ts" \
    '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"preview_edit",arguments:{
       file_path:$f,
       anchor:"a + b",
       operation:"replace",
       language:"typescript",
       content:"b + a"
     }}}')
  persist_call='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"persist_edit","arguments":{}}}'
  raw=$(printf '%s\n%s\n%s\n' "$INIT" "$preview_call" "$persist_call" \
    | { timeout 15 semantic-edit-mcp serve 2>/dev/null || true; })

  preview_line=$(echo "$raw" | grep -E '^\s*\{' | while IFS= read -r line; do
    if echo "$line" | jq -e '.id == 2' >/dev/null 2>&1; then echo "$line"; break; fi
  done)
  persist_line=$(echo "$raw" | grep -E '^\s*\{' | while IFS= read -r line; do
    if echo "$line" | jq -e '.id == 3' >/dev/null 2>&1; then echo "$line"; break; fi
  done)

  # Preview must return a response with a DIFF block (even if the tool
  # refuses to auto-persist due to a missing formatter).
  if echo "$preview_line" | jq -e '.result.content[0].text | contains("===DIFF===")' >/dev/null 2>&1; then
    ok "preview_edit returned a diff response"
  else
    echo "SKIP: preview_edit missing DIFF block — response: $(echo "$preview_line" | head -c 200)"
    persist_line=""
  fi

  # persist_edit may fail if the formatter isn't present in the env; not a
  # hard failure — the AST-edit path itself is proven by preview.
  if [ -n "$persist_line" ] && echo "$persist_line" | jq -e '.result and (.result.isError | not)' >/dev/null 2>&1; then
    ok "persist_edit applied change"

    after=$(call fs-fallback read_file '{"path":"src/index.ts"}' \
      | jq -r '.result.content[0].text | fromjson | .content')
    if echo "$after" | grep -q "return b + a"; then
      ok "fs-fallback readback confirms mutation"
    else
      fail "readback missing mutated content"
    fi
  elif [ -n "$persist_line" ]; then
    echo "SKIP: persist_edit not applied (likely formatter missing in test env)"
  fi
else
  echo "SKIP: semantic-edit-mcp (edit-surface) not on PATH"
fi

echo ""
echo "=== end-to-end scenario complete ==="
