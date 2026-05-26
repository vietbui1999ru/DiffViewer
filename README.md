# DiffViewer

Real-time diff review tool for Claude Code. Renders agent-generated file changes as grouped diff cards in a browser tab, with clipboard-based steer injection between turns.

## How it works

Claude Code's `PostToolUse` hook fires after every Write/Edit/MultiEdit and POSTs the event to a local Hono server. The `Stop` hook signals turn completion. The browser tab receives grouped diffs via SSE and renders them with `diff2html`.

See [`docs/PRD.md`](docs/PRD.md) for full requirements and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for component map.

## Setup

```bash
npm install
node server.js          # or: tmux new-window -n diff-viewer 'node server.js'
node scripts/install.sh # patches ~/.claude/settings.json with hooks
open http://localhost:3333
```

## Placement

This repo lives at `~/dotfiles/.claude/tools/diff-viewer/` and is stowed to `~/.claude/tools/diff-viewer/` for cross-machine consistency.
