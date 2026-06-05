#!/usr/bin/env bash
# Fail-silent: never break a Claude turn. Always exit 0.
set +e

URL="http://localhost:3333/event"
TOOL="${CLAUDE_TOOL_NAME:-}"
JSON="${CLAUDE_TOOL_INPUT_JSON:-}"
SID="${CLAUDE_SESSION_ID:-unknown}"

case "$(printf '%s' "$TOOL" | tr '[:upper:]' '[:lower:]')" in
  write|edit|multiedit) ;;
  *) exit 0 ;;
esac

# Collect distinct file paths from the tool input.
if [ "$(printf '%s' "$TOOL" | tr '[:upper:]' '[:lower:]')" = "multiedit" ]; then
  PATHS="$(printf '%s' "$JSON" | jq -r '.edits[].file_path // .file_path' 2>/dev/null | sort -u)"
else
  PATHS="$(printf '%s' "$JSON" | jq -r '.file_path' 2>/dev/null)"
fi
[ -z "$PATHS" ] && exit 0

while IFS= read -r FP; do
  [ -z "$FP" ] && continue
  OLD="$(git show "HEAD:$FP" 2>/dev/null || printf '')"
  NEW="$(cat "$FP" 2>/dev/null || printf '')"
  BODY="$(jq -nc --arg s "$SID" --arg t "$TOOL" --arg p "$FP" \
            --arg o "$OLD" --arg n "$NEW" \
            '{sessionId:$s, tool:$t, path:$p, oldContent:$o, newContent:$n}')"
  curl -sf --max-time 1 -X POST "$URL" \
    -H 'content-type: application/json' -d "$BODY" >/dev/null 2>&1
done <<EOF
$PATHS
EOF

exit 0
