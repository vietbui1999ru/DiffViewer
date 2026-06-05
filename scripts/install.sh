#!/usr/bin/env bash
set -euo pipefail

SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
PTU='~/.claude/tools/diff-viewer/hooks/post-tool-use.sh'
STOP='~/.claude/tools/diff-viewer/hooks/stop.sh'

command -v node >/dev/null 2>&1 || { echo "error: node is required"; exit 1; }

mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

SETTINGS="$SETTINGS" PTU="$PTU" STOP="$STOP" node -e '
  const fs = require("fs");
  const file = process.env.SETTINGS, ptu = process.env.PTU, stop = process.env.STOP;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8") || "{}"); }
  catch (e) { process.stderr.write("error: " + file + " is not valid JSON. Back it up and re-run.\n"); process.exit(1); }
  if (typeof cfg !== "object" || Array.isArray(cfg) || cfg === null) cfg = {};
  if (!Array.isArray(cfg.PostToolUse)) cfg.PostToolUse = [];
  if (!Array.isArray(cfg.Stop)) cfg.Stop = [];

  const has = (arr, cmd) =>
    arr.some(entry => (entry.hooks || []).some(h => h.command === cmd));

  if (!has(cfg.PostToolUse, ptu)) {
    cfg.PostToolUse.push({ matcher: "Write|Edit|MultiEdit",
      hooks: [{ type: "command", command: ptu }] });
  }
  if (!has(cfg.Stop, stop)) {
    cfg.Stop.push({ hooks: [{ type: "command", command: stop }] });
  }
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, file);
'
echo "DiffViewer hooks installed in $SETTINGS"
