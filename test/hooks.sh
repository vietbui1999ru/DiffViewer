#!/usr/bin/env bash
# End-to-end tests for hooks/post-tool-use.sh and hooks/stop.sh.
# Uses a real throwaway git repo in mktemp.
# Verifies sidecar file protocol per V0.6-SIDECAR-SPEC §1,§2,§3.
set -u
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $1"; exit 1; }

REPO="$(mktemp -d)"
trap 'rm -rf "$REPO"' EXIT

# Init git repo
git -C "$REPO" init -q
git -C "$REPO" config user.email "test@test.com"
git -C "$REPO" config user.name "Test"

# Helper: sanitize session id the same way hooks do
sanitize_sid() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-128
}

SID_RAW="session/abc 123!@#"
SID="$(sanitize_sid "$SID_RAW")"

SESSION_DIR="$REPO/.diffviewer/turns/$SID"
PENDING="$SESSION_DIR/.pending.jsonl"

# ------------------------------------------------------------------
# H4: unknown tool -> exit 0, no file written
CLAUDE_TOOL_NAME=Bash CLAUDE_TOOL_INPUT_JSON='{}' CLAUDE_SESSION_ID="$SID_RAW" \
  REPO_ROOT_OVERRIDE="$REPO" ./hooks/post-tool-use.sh
[ $? -eq 0 ] || fail "H4 unknown tool did not exit 0"
[ ! -f "$PENDING" ] || fail "H4 unknown tool wrote pending"
echo "PASS: H4 (unknown tool, no write)"

# ------------------------------------------------------------------
# H2: Write for a new/untracked file -> oldContent empty, pending written
echo 'hello world' > "$REPO/new.js"
CLAUDE_TOOL_NAME=Write \
  CLAUDE_TOOL_INPUT_JSON="$(jq -nc --arg p "$REPO/new.js" '{file_path:$p}')" \
  CLAUDE_SESSION_ID="$SID_RAW" \
  REPO_ROOT_OVERRIDE="$REPO" \
  ./hooks/post-tool-use.sh
[ $? -eq 0 ] || fail "H2 Write did not exit 0"
[ -f "$PENDING" ] || fail "H2 .pending.jsonl not created"

LINE="$(cat "$PENDING")"
printf '%s' "$LINE" | jq -e '.tool == "Write"' >/dev/null 2>&1 || fail "H2 tool field wrong"
printf '%s' "$LINE" | jq -e '.path == "'"$REPO/new.js"'"' >/dev/null 2>&1 || fail "H2 path field wrong"
printf '%s' "$LINE" | jq -e '.oldContent == ""' >/dev/null 2>&1 || fail "H2 oldContent should be empty for untracked"
printf '%s' "$LINE" | jq -e '.newContent == "hello world\n"' >/dev/null 2>&1 || fail "H2 newContent wrong"
echo "PASS: H2 (Write untracked, oldContent empty)"

# ------------------------------------------------------------------
# H1: commit the file, modify it, Write again -> oldContent = committed, newContent = modified
git -C "$REPO" add new.js
git -C "$REPO" commit -q -m "initial"
echo 'hello world v2' > "$REPO/new.js"

rm -f "$PENDING"
CLAUDE_TOOL_NAME=Write \
  CLAUDE_TOOL_INPUT_JSON="$(jq -nc --arg p "$REPO/new.js" '{file_path:$p}')" \
  CLAUDE_SESSION_ID="$SID_RAW" \
  REPO_ROOT_OVERRIDE="$REPO" \
  ./hooks/post-tool-use.sh
[ $? -eq 0 ] || fail "H1 Write did not exit 0"
[ -f "$PENDING" ] || fail "H1 .pending.jsonl not created"

LINE="$(cat "$PENDING")"
printf '%s' "$LINE" | jq -e '.oldContent == "hello world\n"' >/dev/null 2>&1 || fail "H1 oldContent should be committed content"
printf '%s' "$LINE" | jq -e '.newContent == "hello world v2\n"' >/dev/null 2>&1 || fail "H1 newContent wrong"
echo "PASS: H1 (Write existing, oldContent = committed)"

# ------------------------------------------------------------------
# MultiEdit: one event per edits[].file_path
echo 'a' > "$REPO/a.js"
echo 'b' > "$REPO/b.js"
git -C "$REPO" add a.js b.js
git -C "$REPO" commit -q -m "add a b"
echo 'a2' > "$REPO/a.js"
echo 'b2' > "$REPO/b.js"

rm -f "$PENDING"
MULTI_JSON="$(jq -nc \
  --arg pa "$REPO/a.js" \
  --arg pb "$REPO/b.js" \
  '{edits:[{file_path:$pa},{file_path:$pb}]}')"
CLAUDE_TOOL_NAME=MultiEdit \
  CLAUDE_TOOL_INPUT_JSON="$MULTI_JSON" \
  CLAUDE_SESSION_ID="$SID_RAW" \
  REPO_ROOT_OVERRIDE="$REPO" \
  ./hooks/post-tool-use.sh
[ $? -eq 0 ] || fail "MultiEdit did not exit 0"
COUNT="$(wc -l < "$PENDING" | tr -d ' ')"
[ "$COUNT" = "2" ] || fail "MultiEdit should produce 2 pending lines, got $COUNT"
# Both tool values should be MultiEdit
jq -e '.tool == "MultiEdit"' < <(sed -n '1p' "$PENDING") >/dev/null 2>&1 || fail "MultiEdit line1 tool wrong"
jq -e '.tool == "MultiEdit"' < <(sed -n '2p' "$PENDING") >/dev/null 2>&1 || fail "MultiEdit line2 tool wrong"
echo "PASS: H-MultiEdit (one line per file)"

# ------------------------------------------------------------------
# Edit: case-insensitive match
echo 'c' > "$REPO/c.js"
git -C "$REPO" add c.js
git -C "$REPO" commit -q -m "add c"
echo 'c2' > "$REPO/c.js"

rm -f "$PENDING"
CLAUDE_TOOL_NAME=edit \
  CLAUDE_TOOL_INPUT_JSON="$(jq -nc --arg p "$REPO/c.js" '{file_path:$p}')" \
  CLAUDE_SESSION_ID="$SID_RAW" \
  REPO_ROOT_OVERRIDE="$REPO" \
  ./hooks/post-tool-use.sh
[ $? -eq 0 ] || fail "edit (lower) did not exit 0"
[ -f "$PENDING" ] || fail "edit (lower) .pending.jsonl not created"
echo "PASS: H-Edit (case-insensitive)"

# ------------------------------------------------------------------
# S1: stop.sh with pending -> produces turn-1.json, removes .pending.jsonl
# Rebuild a clean single pending line
rm -f "$PENDING"
echo 'fresh' > "$REPO/fresh.js"
git -C "$REPO" add fresh.js
git -C "$REPO" commit -q -m "add fresh"
echo 'fresh v2' > "$REPO/fresh.js"

CLAUDE_TOOL_NAME=Write \
  CLAUDE_TOOL_INPUT_JSON="$(jq -nc --arg p "$REPO/fresh.js" '{file_path:$p}')" \
  CLAUDE_SESSION_ID="$SID_RAW" \
  REPO_ROOT_OVERRIDE="$REPO" \
  ./hooks/post-tool-use.sh

# capture mtime of pending for startedAt approximation check (best-effort)
[ -f "$PENDING" ] || fail "S1 setup: pending not created"

CLAUDE_SESSION_ID="$SID_RAW" \
  REPO_ROOT_OVERRIDE="$REPO" \
  ./hooks/stop.sh
[ $? -eq 0 ] || fail "S1 stop.sh did not exit 0"

TURN1="$SESSION_DIR/turn-1.json"
[ -f "$TURN1" ] || fail "S1 turn-1.json not created"
[ -s "$TURN1" ] || fail "S1 turn-1.json is empty"
[ ! -f "$PENDING" ] || fail "S1 .pending.jsonl not removed after stop"

# Schema assertions per spec §1
jq -e '.version == 1' "$TURN1" >/dev/null 2>&1 || fail "S1 version != 1"
jq -e '.sessionId == "'"$SID"'"' "$TURN1" >/dev/null 2>&1 || fail "S1 sessionId wrong"
jq -e '.harness == "claude-code"' "$TURN1" >/dev/null 2>&1 || fail "S1 harness wrong"
jq -e '.task == null' "$TURN1" >/dev/null 2>&1 || fail "S1 task should be null"
jq -e '.turnNumber == 1' "$TURN1" >/dev/null 2>&1 || fail "S1 turnNumber should be 1"
jq -e '.startedAt | type == "number"' "$TURN1" >/dev/null 2>&1 || fail "S1 startedAt not number"
jq -e '.completedAt | type == "number"' "$TURN1" >/dev/null 2>&1 || fail "S1 completedAt not number"
jq -e '.completedAt >= .startedAt' "$TURN1" >/dev/null 2>&1 || fail "S1 completedAt < startedAt"
# startedAt must be epoch-ms (> 1e12 = year ~2001+), not epoch-seconds
jq -e '.startedAt > 1000000000000' "$TURN1" >/dev/null 2>&1 || fail "S1 startedAt looks like epoch-seconds not epoch-ms"
jq -e '(.events | length) == 1' "$TURN1" >/dev/null 2>&1 || fail "S1 events length should be 1"
jq -e '.events[0].tool == "Write"' "$TURN1" >/dev/null 2>&1 || fail "S1 event tool wrong"
jq -e '.events[0].path | length > 0' "$TURN1" >/dev/null 2>&1 || fail "S1 event path empty"
jq -e '.events[0].oldContent | type == "string"' "$TURN1" >/dev/null 2>&1 || fail "S1 event oldContent not string"
jq -e '.events[0].newContent | type == "string"' "$TURN1" >/dev/null 2>&1 || fail "S1 event newContent not string"
# events must not contain internal .ts transport field
jq -e '.events[0] | has("ts") | not' "$TURN1" >/dev/null 2>&1 || fail "S1 event should not expose internal ts field"
echo "PASS: S1 (stop produces turn-1.json, correct schema)"

# ------------------------------------------------------------------
# Second turn: produces turn-2.json
echo 'next' > "$REPO/next.js"
git -C "$REPO" add next.js
git -C "$REPO" commit -q -m "add next"
echo 'next v2' > "$REPO/next.js"

CLAUDE_TOOL_NAME=Write \
  CLAUDE_TOOL_INPUT_JSON="$(jq -nc --arg p "$REPO/next.js" '{file_path:$p}')" \
  CLAUDE_SESSION_ID="$SID_RAW" \
  REPO_ROOT_OVERRIDE="$REPO" \
  ./hooks/post-tool-use.sh

CLAUDE_SESSION_ID="$SID_RAW" \
  REPO_ROOT_OVERRIDE="$REPO" \
  ./hooks/stop.sh

TURN2="$SESSION_DIR/turn-2.json"
[ -f "$TURN2" ] || fail "turn-2.json not created for second stop"
jq -e '.turnNumber == 2' "$TURN2" >/dev/null 2>&1 || fail "turn-2.json turnNumber should be 2"
echo "PASS: second turn produces turn-2.json"

# ------------------------------------------------------------------
# Empty turn: stop with no pending -> no new turn file
TURN3="$SESSION_DIR/turn-3.json"
CLAUDE_SESSION_ID="$SID_RAW" \
  REPO_ROOT_OVERRIDE="$REPO" \
  ./hooks/stop.sh
[ ! -f "$TURN3" ] || fail "empty turn should produce no file"
echo "PASS: empty turn produces no file"

# ------------------------------------------------------------------
# Corrupt pending: stop.sh should NOT produce a turn file and must preserve .pending.jsonl
printf 'THIS IS NOT JSON\n' > "$PENDING"
NEXT_TURN="$SESSION_DIR/turn-3.json"
CLAUDE_SESSION_ID="$SID_RAW" \
  REPO_ROOT_OVERRIDE="$REPO" \
  ./hooks/stop.sh
[ $? -eq 0 ] || fail "corrupt pending: stop.sh did not exit 0"
[ ! -f "$NEXT_TURN" ] || fail "corrupt pending: stop.sh wrote turn-3.json despite jq failure"
[ -f "$PENDING" ] || fail "corrupt pending: stop.sh deleted .pending.jsonl on jq failure (events lost)"
# Clean up for next test
rm -f "$PENDING"
echo "PASS: corrupt pending produces no turn file, preserves .pending.jsonl"

# ------------------------------------------------------------------
# Non-git dir: graceful skip, exit 0
NONGIT="$(mktemp -d)"
trap 'rm -rf "$NONGIT"' EXIT
echo 'x' > "$NONGIT/x.js"
CLAUDE_TOOL_NAME=Write \
  CLAUDE_TOOL_INPUT_JSON="$(jq -nc --arg p "$NONGIT/x.js" '{file_path:$p}')" \
  CLAUDE_SESSION_ID="$SID_RAW" \
  ./hooks/post-tool-use.sh
[ $? -eq 0 ] || fail "non-git dir did not exit 0"
echo "PASS: non-git dir exits 0 cleanly"

echo ""
echo "All hook tests passed."
