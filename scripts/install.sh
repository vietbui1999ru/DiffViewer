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

  // Spec AC: scan all entries hooks[].command for the diff-viewer substring — prevents
  // duplicates even when path differs slightly (e.g., trailing slash, prior install path).
  // Note: JS string uses double quotes because this code is inside a bash single-quoted block.
  const has = (arr, cmd) =>
    arr.some(entry => (entry.hooks || []).some(h =>
      h.command === cmd || h.command.includes("diff-viewer")));

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

# Idempotently add .diffviewer/ to the user's global git excludes file (spec §5).
# Resolve path: git config core.excludesFile, falling back to ~/.config/git/ignore.
GIT_EXCLUDES="$(git config --global core.excludesFile 2>/dev/null || true)"
if [ -z "$GIT_EXCLUDES" ]; then
  GIT_EXCLUDES="$HOME/.config/git/ignore"
fi
# Expand ~ manually since the value may come from git config as a literal tilde path
case "$GIT_EXCLUDES" in
  "~/"*) GIT_EXCLUDES="$HOME/${GIT_EXCLUDES#"~/"}" ;;
esac
mkdir -p "$(dirname "$GIT_EXCLUDES")"
touch "$GIT_EXCLUDES"
# Append only if not already present (idempotent)
if ! grep -qxF '.diffviewer/' "$GIT_EXCLUDES" 2>/dev/null; then
  printf '\n.diffviewer/\n' >> "$GIT_EXCLUDES"
  echo "Added .diffviewer/ to $GIT_EXCLUDES"
else
  echo ".diffviewer/ already in $GIT_EXCLUDES"
fi
