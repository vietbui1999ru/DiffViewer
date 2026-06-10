#!/usr/bin/env bash
# Fail-silent: never break a Claude turn. Always exit 0.
# Appends one compact JSON line per edited file to <repo>/.diffviewer/turns/<sessionId>/.pending.jsonl
set +e

TOOL="${CLAUDE_TOOL_NAME:-}"
JSON="${CLAUDE_TOOL_INPUT_JSON:-}"
SID_RAW="${CLAUDE_SESSION_ID:-unknown}"

# Case-insensitive tool filter
case "$(printf '%s' "$TOOL" | tr '[:upper:]' '[:lower:]')" in
  write|edit|multiedit) ;;
  *) exit 0 ;;
esac

# Sanitize sessionId: replace non-[A-Za-z0-9._-] with _, max 128 chars (spec §1)
SID="$(printf '%s' "$SID_RAW" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-128)"

# Collect file paths: MultiEdit uses edits[].file_path, others use file_path
if [ "$(printf '%s' "$TOOL" | tr '[:upper:]' '[:lower:]')" = "multiedit" ]; then
  PATHS="$(printf '%s' "$JSON" | jq -r '.edits[].file_path' 2>/dev/null)"
else
  PATHS="$(printf '%s' "$JSON" | jq -r '.file_path // empty' 2>/dev/null)"
fi
[ -z "$PATHS" ] && exit 0

# Capture event timestamp in epoch ms (spec §1: startedAt = first captured event).
# date +%s%3N is GNU-only (fails on macOS). Use node (always available per install.sh),
# falling back to python3, then to epoch-seconds * 1000.
TS="$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null \
  || python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null \
  || printf '%s' "$(date +%s)000")"

while IFS= read -r FP; do
  [ -z "$FP" ] && continue

  # Determine repo root for this file.
  # REPO_ROOT_OVERRIDE is used in tests to inject a fake repo root.
  if [ -n "${REPO_ROOT_OVERRIDE:-}" ]; then
    REPO_ROOT="$REPO_ROOT_OVERRIDE"
  else
    FILE_DIR="$(dirname "$FP")"
    REPO_ROOT="$(git -C "$FILE_DIR" rev-parse --show-toplevel 2>/dev/null)"
    # Skip if not in a git repo
    [ -z "$REPO_ROOT" ] && continue
  fi

  SESSION_DIR="$REPO_ROOT/.diffviewer/turns/$SID"

  # Prune stale session dirs at session start — spec §5: "at session start (best-effort)".
  # Guard: only run pruning when this session dir does not yet exist (first tool call of a new session).
  TURNS_ROOT="$REPO_ROOT/.diffviewer/turns"
  if [ ! -d "$SESSION_DIR" ] && [ -d "$TURNS_ROOT" ]; then
    find "$TURNS_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
  fi

  mkdir -p "$SESSION_DIR"

  PENDING="$SESSION_DIR/.pending.jsonl"

  # oldContent: git show HEAD:<relative-path>, empty if untracked/non-git/new
  # newContent: read current disk content
  # Write to tmp files so jq --rawfile can slurp them — avoids shell word-splitting
  # on large or binary content (spec edge case). We write directly (no printf strip).
  TMPOLD="$(mktemp)"
  TMPNEW="$(mktemp)"

  # Compute path relative to repo root for git show.
  # realpath --relative-to is GNU-only; use Python as a portable cross-platform fallback.
  REL_PATH="$(python3 -c "import os,sys; print(os.path.relpath(sys.argv[1],sys.argv[2]))" "$FP" "$REPO_ROOT" 2>/dev/null || printf '%s' "$FP")"
  git -C "$REPO_ROOT" show "HEAD:$REL_PATH" > "$TMPOLD" 2>/dev/null || : > "$TMPOLD"

  # newContent: read current disk state
  cat "$FP" > "$TMPNEW" 2>/dev/null || : > "$TMPNEW"

  # Include ts (epoch ms) so stop.sh can derive startedAt from the first event (spec §1)
  LINE="$(jq -cn \
    --arg tool "$TOOL" \
    --arg path "$FP" \
    --argjson ts "$TS" \
    --rawfile oldContent "$TMPOLD" \
    --rawfile newContent "$TMPNEW" \
    '{tool:$tool, path:$path, ts:$ts, oldContent:$oldContent, newContent:$newContent}')"

  rm -f "$TMPOLD" "$TMPNEW"

  [ -z "$LINE" ] && continue

  # POSIX append — atomic per line (spec §3)
  printf '%s\n' "$LINE" >> "$PENDING"

done <<EOF
$PATHS
EOF

exit 0
