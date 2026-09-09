#!/usr/bin/env bash
# tests/scenarios/graph-edit-workflow.sh — real MCP tool-call workflows against
# the graph-edit-sample fixture. Each scenario snapshots the fixture into a
# fresh temp dir, spawns a clean graph-edit session cwd'd there, and asserts
# on the JSON-RPC responses and on-disk state.
#
# If graph-edit isn't on PATH, all scenarios are skipped cleanly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/tests/fixtures/graph-edit-sample"

if ! command -v graph-edit >/dev/null 2>&1; then
  echo "SKIP: graph-edit not on PATH (Phase 6A root flake integration pending)"
  exit 0
fi

if [ ! -d "$FIXTURE_DIR" ]; then
  echo "FAIL: fixture missing at $FIXTURE_DIR"
  exit 1
fi

# Global scratch parent — one subdir per scenario so failures leave breadcrumbs.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Isolate caches so we don't pollute the user's ~/.cache.
export XDG_CACHE_HOME="$TMP/.xdg-cache"
mkdir -p "$XDG_CACHE_HOME"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"scenario","version":"0.1.0"}}}'

# snapshot <scenario-name> → prints the fresh copy path
snapshot() {
  local name="$1"
  local dir="$TMP/scenario-$name"
  cp -a "$FIXTURE_DIR/." "$dir/" 2>/dev/null || {
    mkdir -p "$dir"
    cp -a "$FIXTURE_DIR/." "$dir/"
  }
  echo "$dir"
}

# run_calls <cwd> <req1> [<req2> ...] → prints newline-separated JSON responses
# (all stdout lines that start with { or "). Each req is a JSON-RPC request line.
run_calls() {
  local cwd="$1"; shift
  local reqs=()
  reqs+=("$INIT")
  for req in "$@"; do reqs+=("$req"); done
  local joined
  joined=$(printf '%s\n' "${reqs[@]}")
  # cwd must be set so graph-edit's config discovery locks onto the fixture.
  (cd "$cwd" && printf '%s\n' "$joined" | timeout 60 graph-edit 2>/dev/null || true)
}

# pick_id <response-batch> <id> → prints the JSON-RPC response line with that id
pick_id() {
  local batch="$1"; local want="$2"
  echo "$batch" | grep -E '^\s*\{' | while IFS= read -r line; do
    if echo "$line" | jq -e --argjson i "$want" '.id == $i and (.result // .error)' >/dev/null 2>&1; then
      echo "$line"
      break
    fi
  done
}

# text_of <response> → prints the tool-call inner text (JSON string)
text_of() {
  echo "$1" | jq -r '.result.content[0].text' 2>/dev/null || echo ""
}

ok()   { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

# ── Scenario 1 — Add method to class ─────────────────────────────────────
echo "=== Scenario 1: add_method → preview → commit ==="
DIR=$(snapshot "add-method")

add_req=$(jq -nc '{
  jsonrpc:"2.0", id:2, method:"tools/call",
  params:{
    name:"add_method",
    arguments:{
      class_id:"sym:src/services/user.ts#UserService",
      name:"deactivate",
      signature:"async deactivate(): Promise<void>",
      body:"this.active = false;\nthis.eventBus.emit(\"user.deactivated\", { id: this.id });"
    }
  }
}')
preview_req='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"preview","arguments":{}}}'
commit_req='{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"commit","arguments":{}}}'

batch=$(run_calls "$DIR" "$add_req" "$preview_req" "$commit_req")

add_resp=$(pick_id "$batch" 2)
preview_resp=$(pick_id "$batch" 3)
commit_resp=$(pick_id "$batch" 4)

[ -n "$add_resp" ] || fail "scenario1: no add_method response"
add_text=$(text_of "$add_resp")
echo "$add_text" | jq -e '.data.kind == "add_method"' >/dev/null \
  || fail "scenario1: add_method didn't return a pending mutation: $add_text"
ok "scenario1: add_method returned pending mutation"

[ -n "$preview_resp" ] || fail "scenario1: no preview response"
preview_text=$(text_of "$preview_resp")
echo "$preview_text" | jq -e '.type_check == "pass"' >/dev/null \
  || fail "scenario1: preview type_check not pass: $preview_text"
echo "$preview_text" | jq -e '.diff | length > 0' >/dev/null \
  || fail "scenario1: preview diff empty"
ok "scenario1: preview type_check=pass, diff non-empty"

[ -n "$commit_resp" ] || fail "scenario1: no commit response"
commit_text=$(text_of "$commit_resp")
echo "$commit_text" | jq -e '.files_written | index("src/services/user.ts")' >/dev/null \
  || fail "scenario1: commit files_written missing user.ts: $commit_text"
grep -q "deactivate" "$DIR/src/services/user.ts" \
  || fail "scenario1: user.ts on disk missing 'deactivate' after commit"
ok "scenario1: commit wrote user.ts with deactivate method"

# ── Scenario 2 — Rename across codebase ──────────────────────────────────
echo "=== Scenario 2: describe_change_zone → rename_symbol → commit ==="
DIR=$(snapshot "rename")

zone_req=$(jq -nc '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"describe_change_zone",arguments:{id:"sym:src/services/user.ts#UserService.load"}}}')
rename_req=$(jq -nc '{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"rename_symbol",arguments:{id:"sym:src/services/user.ts#UserService.load",new_name:"loadById"}}}')
commit_req='{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"commit","arguments":{}}}'

batch=$(run_calls "$DIR" "$zone_req" "$rename_req" "$commit_req")
zone_resp=$(pick_id "$batch" 2)
rename_resp=$(pick_id "$batch" 3)
commit_resp=$(pick_id "$batch" 4)

[ -n "$zone_resp" ] || fail "scenario2: no describe_change_zone response"
zone_text=$(text_of "$zone_resp")
echo "$zone_text" | jq -e '.data.target.id == "sym:src/services/user.ts#UserService.load"' >/dev/null \
  || fail "scenario2: describe_change_zone target wrong: $zone_text"
ok "scenario2: describe_change_zone returned target"

[ -n "$rename_resp" ] || fail "scenario2: no rename response"
rename_text=$(text_of "$rename_resp")
echo "$rename_text" | jq -e '.data.kind == "rename_symbol"' >/dev/null \
  || fail "scenario2: rename_symbol didn't return a pending mutation: $rename_text"
ok "scenario2: rename_symbol returned pending mutation"

[ -n "$commit_resp" ] || fail "scenario2: no commit response"
commit_text=$(text_of "$commit_resp")

# Rename should have updated at least 3 files on disk: user.ts (definition),
# auth.ts (caller), user.test.ts (may or may not — test file references
# UserService but not .load directly; ensure at minimum user.ts + auth.ts touched).
files_written_count=$(echo "$commit_text" | jq -r '.files_written | length')
[ "$files_written_count" -ge 2 ] \
  || fail "scenario2: commit wrote <2 files (got $files_written_count): $commit_text"
ok "scenario2: commit files_written count=$files_written_count"

# Count how many source files on disk now contain the new name.
updated=0
for f in "$DIR/src/services/user.ts" "$DIR/src/services/auth.ts" "$DIR/src/services/user.test.ts"; do
  if grep -q "loadById" "$f" 2>/dev/null; then
    updated=$((updated + 1))
  fi
done
if [ "$updated" -ge 3 ]; then
  ok "scenario2: 'loadById' present in $updated fixture files on disk"
elif [ "$updated" -ge 2 ]; then
  ok "scenario2: 'loadById' present in $updated files (test file didn't reference .load directly — expected)"
else
  fail "scenario2: expected 'loadById' in >=2 files, found $updated"
fi

# ── Scenario 3 — Understand codebase ─────────────────────────────────────
echo "=== Scenario 3: explore intent-based briefing ==="
DIR=$(snapshot "explore")

# Use an intent whose keywords ("auth service") ensure the auth-related
# module surfaces as a pattern hit even though no rate-limiting code exists.
explore_req=$(jq -nc '{
  jsonrpc:"2.0", id:2, method:"tools/call",
  params:{
    name:"explore",
    arguments:{intent:"add rate limiting to the auth service"}
  }
}')

batch=$(run_calls "$DIR" "$explore_req")
explore_resp=$(pick_id "$batch" 2)
[ -n "$explore_resp" ] || fail "scenario3: no explore response"
explore_text=$(text_of "$explore_resp")

# Assert: (target non-null OR patterns non-empty) AND layout_preview.module set.
has_target=$(echo "$explore_text" | jq -r '.data.target != null')
has_patterns=$(echo "$explore_text" | jq -r '(.data.patterns | length) > 0')
if [ "$has_target" != "true" ] && [ "$has_patterns" != "true" ]; then
  fail "scenario3: explore returned neither target nor patterns: $explore_text"
fi
ok "scenario3: explore returned target=$has_target patterns_non_empty=$has_patterns"

echo "$explore_text" | jq -e '.data.layout_preview.module | type == "string" and length > 0' >/dev/null \
  || fail "scenario3: layout_preview.module missing/empty: $explore_text"
ok "scenario3: explore layout_preview has module field"

# ── Scenario 4 — Delete unused code (refusal path) ───────────────────────
echo "=== Scenario 4: delete_symbol with refactor_callers=refuse ==="
DIR=$(snapshot "delete")

# UserService has 6 callers in the fixture — deleting with refuse must refuse.
del_req=$(jq -nc '{
  jsonrpc:"2.0", id:2, method:"tools/call",
  params:{
    name:"delete_symbol",
    arguments:{
      id:"sym:src/services/user.ts#UserService",
      refactor_callers:"refuse"
    }
  }
}')

batch=$(run_calls "$DIR" "$del_req")
del_resp=$(pick_id "$batch" 2)
[ -n "$del_resp" ] || fail "scenario4: no delete_symbol response"
del_text=$(text_of "$del_resp")

echo "$del_text" | jq -e '.data == null' >/dev/null \
  || fail "scenario4: expected data:null, got: $del_text"
ok "scenario4: delete refused (data:null)"

echo "$del_text" | jq -e '.warnings[0].kind == "refusal_has_callers"' >/dev/null \
  || fail "scenario4: warnings[0].kind != refusal_has_callers: $del_text"
ok "scenario4: warning kind=refusal_has_callers"

# Fixture must be unchanged.
if [ ! -f "$DIR/src/services/user.ts" ] || ! grep -q "class UserService" "$DIR/src/services/user.ts"; then
  fail "scenario4: UserService disappeared from disk after refusal"
fi
ok "scenario4: fixture unchanged after refusal"

echo ""
echo "=== graph-edit workflow scenarios: ALL PASSED ==="
