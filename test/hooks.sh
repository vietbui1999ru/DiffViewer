#!/usr/bin/env bash
# Verifies fail-silent behavior and that a known tool POSTs a well-formed body.
set -u
fail() { echo "FAIL: $1"; exit 1; }

# AC-H3: server down -> exit 0 within ~1s
CLAUDE_TOOL_NAME=Write CLAUDE_TOOL_INPUT_JSON='{"file_path":"/tmp/nope.js"}' \
  CLAUDE_SESSION_ID=t1 timeout 3 ./hooks/post-tool-use.sh
[ $? -eq 0 ] || fail "H3 post-tool-use did not exit 0 with server down"

CLAUDE_SESSION_ID=t1 timeout 3 ./hooks/stop.sh
[ $? -eq 0 ] || fail "S1 stop.sh did not exit 0 with server down"

# AC-H4: unknown tool -> exit 0, no work
CLAUDE_TOOL_NAME=Bash CLAUDE_TOOL_INPUT_JSON='{}' CLAUDE_SESSION_ID=t1 ./hooks/post-tool-use.sh
[ $? -eq 0 ] || fail "H4 unknown tool not exit 0"

# AC-H1: capture POST body against a one-shot listener
TMP="$(mktemp)"
trap 'kill "$NCPID" 2>/dev/null; rm -f "$TMP" /tmp/dv_hooktest.js' EXIT
{ printf 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'; } | nc -l 3333 >"$TMP" 2>/dev/null &
NCPID=$!
sleep 0.3
echo 'console.log(1)' > /tmp/dv_hooktest.js
CLAUDE_TOOL_NAME=Write CLAUDE_TOOL_INPUT_JSON='{"file_path":"/tmp/dv_hooktest.js"}' \
  CLAUDE_SESSION_ID=t1 ./hooks/post-tool-use.sh
sleep 0.5
wait $NCPID 2>/dev/null
grep -q '"path":"/tmp/dv_hooktest.js"' "$TMP" || fail "H1 POST body missing path"
grep -q '"tool":"Write"' "$TMP" || fail "H1 POST body missing tool"
grep -q '"sessionId":"t1"' "$TMP" || fail "H1 POST body missing sessionId"
grep -q '"newContent":"console.log(1)"' "$TMP" || fail "H1 POST body missing newContent"
grep -q '"oldContent":""' "$TMP" || fail "H1 POST body missing oldContent"
echo "PASS: hooks"
