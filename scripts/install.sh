#!/usr/bin/env bash
set -euo pipefail

SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
PTU='~/.claude/tools/diff-viewer/hooks/post-tool-use.sh'
STOP='~/.claude/tools/diff-viewer/hooks/stop.sh'

mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

SETTINGS="$SETTINGS" PTU="$PTU" STOP="$STOP" node -e '
  const fs = require("fs");
  const file = process.env.SETTINGS, ptu = process.env.PTU, stop = process.env.STOP;
  const cfg = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
  cfg.PostToolUse ||= [];
  cfg.Stop ||= [];

  const has = (arr, cmd) =>
    arr.some(entry => (entry.hooks || []).some(h => h.command === cmd));

  if (!has(cfg.PostToolUse, ptu)) {
    cfg.PostToolUse.push({ matcher: "Write|Edit|MultiEdit",
      hooks: [{ type: "command", command: ptu }] });
  }
  if (!has(cfg.Stop, stop)) {
    cfg.Stop.push({ hooks: [{ type: "command", command: stop }] });
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
'
echo "DiffViewer hooks installed in $SETTINGS"
