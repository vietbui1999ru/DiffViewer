#!/usr/bin/env bash
# Fail-silent: never break a Claude session. Always exit 0.
# If .pending.jsonl exists and non-empty: wrap into turn-N.json envelope per spec §1/§2.
# startedAt: first captured event's .ts field (epoch ms, added by post-tool-use.sh).
#            Falls back to file mtime * 1000 if .ts is absent (migration / manual writes).
# completedAt: current epoch ms at snapshot write time.
set +e

SID_RAW="${CLAUDE_SESSION_ID:-unknown}"
SID="$(printf '%s' "$SID_RAW" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-128)"

# Determine repo root.
# REPO_ROOT_OVERRIDE is used in tests to inject a fake repo root.
if [ -n "${REPO_ROOT_OVERRIDE:-}" ]; then
  REPO_ROOT="$REPO_ROOT_OVERRIDE"
else
  REPO_ROOT="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)"
fi
[ -z "$REPO_ROOT" ] && exit 0

SESSION_DIR="$REPO_ROOT/.diffviewer/turns/$SID"
PENDING="$SESSION_DIR/.pending.jsonl"

# Prune session dirs >7 days old at stop time too (secondary best-effort pass per spec §5).
# Primary pruning is in post-tool-use.sh on session start.
TURNS_ROOT="$REPO_ROOT/.diffviewer/turns"
if [ -d "$TURNS_ROOT" ]; then
  find "$TURNS_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
fi

# If no pending or empty, nothing to do
[ -f "$PENDING" ] || exit 0
[ -s "$PENDING" ] || exit 0

# Determine next turn number: max existing non-empty turn-N.json N + 1
# Only count non-empty files to avoid counting leftover 0-byte files from previous jq failures.
NEXT_N=1
LAST=""
for f in "$SESSION_DIR"/turn-*.json; do
  [ -s "$f" ] || continue
  n="$(printf '%s' "$f" | sed 's/.*turn-\([0-9]*\)\.json/\1/')"
  if [ -n "$n" ] && [ "$n" -gt "${LAST:-0}" ] 2>/dev/null; then
    LAST="$n"
  fi
done
[ -n "$LAST" ] && NEXT_N="$((LAST + 1))"

TMP_TURN="$SESSION_DIR/.tmp-turn-${NEXT_N}.json"
TURN_FILE="$SESSION_DIR/turn-${NEXT_N}.json"

# startedAt: extract .ts from first pending line (epoch ms, set by post-tool-use.sh at capture time).
# This satisfies spec §1: "startedAt = first captured event".
# Fallback: file mtime * 1000 when .ts is absent (e.g., manually crafted pending lines).
STARTED_AT="$(jq -r 'first | .ts // empty' "$PENDING" 2>/dev/null)"
if [ -z "$STARTED_AT" ] || [ "$STARTED_AT" = "null" ]; then
  # mtime fallback: macOS uses stat -f %m, Linux uses stat -c %Y
  MTIME_S="$(stat -f %m "$PENDING" 2>/dev/null || stat -c %Y "$PENDING" 2>/dev/null || printf '')"
  if [ -n "$MTIME_S" ]; then
    STARTED_AT="$((MTIME_S * 1000))"
  else
    STARTED_AT="$(date +%s)000"
  fi
fi

# completedAt: current epoch ms
COMPLETED_AT="$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null)"
[ -z "$COMPLETED_AT" ] && COMPLETED_AT="$(date +%s)000"

# Resolve task id (§7 fix):
#   1. $AGENTS_TASK_ID env var if non-empty
#   2. Current branch name matching agent/<task-id> exactly → strip "agent/" prefix
#   3. null
TASK_ID_VAL="null"
if [ -n "${AGENTS_TASK_ID:-}" ]; then
  # Sanitize: only allow ^[A-Za-z0-9._-]+$
  sanitized="$(printf '%s' "$AGENTS_TASK_ID" | tr -cd 'A-Za-z0-9._-')"
  if [ -n "$sanitized" ]; then
    TASK_ID_VAL="\"$sanitized\""
  fi
else
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  case "$branch" in
    agent/*)
      suffix="${branch#agent/}"
      # Validate suffix matches ^[A-Za-z0-9._-]+$
      sanitized="$(printf '%s' "$suffix" | tr -cd 'A-Za-z0-9._-')"
      if [ "$sanitized" = "$suffix" ] && [ -n "$suffix" ]; then
        TASK_ID_VAL="\"$suffix\""
      fi
      ;;
  esac
fi

# Build the envelope: jq -s reads all pending lines as array
# Fields per spec §1: version, sessionId, harness, task, turnNumber, startedAt, completedAt, events
# Strip internal .ts field from each event before writing — it is a transport-only field
jq -sc \
  --arg sid "$SID" \
  --argjson n "$NEXT_N" \
  --argjson started "$STARTED_AT" \
  --argjson completed "$COMPLETED_AT" \
  --argjson task "$TASK_ID_VAL" \
  '{
    version: 1,
    sessionId: $sid,
    harness: "claude-code",
    task: $task,
    turnNumber: $n,
    startedAt: $started,
    completedAt: $completed,
    events: [.[] | del(.ts)]
  }' "$PENDING" > "$TMP_TURN" 2>/dev/null

# Guard: only rename if jq produced a non-empty result.
# An empty $TMP_TURN means jq failed (corrupt pending). Preserve .pending.jsonl for inspection.
# Do NOT write a 0-byte turn file — the watcher would log parse errors on every startup scan.
if [ ! -s "$TMP_TURN" ]; then
  rm -f "$TMP_TURN"
  exit 0
fi

# Atomic rename (spec §2)
mv "$TMP_TURN" "$TURN_FILE" 2>/dev/null || { rm -f "$TMP_TURN"; exit 0; }

# Remove pending only after confirmed successful write
rm -f "$PENDING"

exit 0
