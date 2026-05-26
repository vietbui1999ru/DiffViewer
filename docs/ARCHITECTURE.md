# Architecture

## Component map

```
Claude Code
  PostToolUse hook  →  curl POST :3333/event     (per Write/Edit/MultiEdit)
  Stop hook         →  curl POST :3333/turn-end   (turn boundary signal)

~/.claude/tools/diff-viewer/server.js  (Hono, always-running daemon)
  POST /event       →  buffer into current turn (TurnBuffer)
  POST /turn-end    →  flush turn → SSE broadcast (Broadcaster)
  POST /steer       →  pbcopy (v1) / tmux send-keys (v2)
  GET  /stream      →  SSE to browser
  GET  /            →  serve browser/index.html

browser/  (diff2html + vanilla JS, no build step)
  EventSource → render per-turn grouped diff cards → steer input box
```

## Staged roadmap

### v1 — File diff review + clipboard steer
- Hono server, SSE, diff2html rendering
- PostToolUse + Stop hooks wired globally
- Per-turn grouped diff cards in browser
- Steer box → clipboard on Send

### v2 — Full turn summary + tmux injection
- Extend hook capture to Bash commands
- Collapsible turn groups with file tree summary
- tmux send-keys injection replaces clipboard

### v3 (candidate)
- Append each turn to `~/.claude/diff-history.jsonl` for cross-session replay

## Placement

`~/dotfiles/.claude/tools/diff-viewer/` stowed to `~/.claude/tools/diff-viewer/`.
Hooks registered globally in `~/.claude/settings.json` — active in every project.
Daemon: `tmux new-window -n diff-viewer 'node ~/.claude/tools/diff-viewer/server.js'`
