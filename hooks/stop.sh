#!/usr/bin/env bash
set +e
SID="${CLAUDE_SESSION_ID:-unknown}"
curl -sf --max-time 1 -X POST "http://localhost:3333/turn-end" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg s "$SID" '{sessionId:$s}')" >/dev/null 2>&1
exit 0
