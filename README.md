# DiffViewer

Real-time diff review tool for Claude Code. Renders agent-generated file changes as grouped diff cards in a browser tab, with clipboard-based steer injection between turns.

## How it works

Claude Code's `PostToolUse` hook fires after every Write/Edit/MultiEdit and POSTs the event to a local Hono server. The `Stop` hook signals turn completion. The browser tab receives grouped diffs via SSE and renders them with `diff2html`.

See [`docs/PRD.md`](docs/PRD.md) for full requirements and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for component map.

## Pi worker extension

This repo also contains `pi-extension/`, a Pi package for the OpenCode/Claude commander → Pi worker workflow. It intercepts Pi worker `write`/`edit` tool changes and opens an interactive line-level Accept/Edit/Deny review UI before the worker continues. Decisions are written to `.pi/diff-review/decisions.jsonl` and `.pi/diff-review/latest.md` so the commander can inspect what the worker actually changed.

```bash
pi install /Users/vietquocbui/repos/DiffViewer/pi-extension
# or one-off:
pi -e /Users/vietquocbui/repos/DiffViewer/pi-extension
```

## Setup

Requires Node 20+, `jq`, and `curl`.

```bash
npm install
node server.js          # or: tmux new-window -n diff-viewer 'node server.js'
bash scripts/install.sh # patches ~/.claude/settings.json with hooks (idempotent)
open http://localhost:3333
```

v0.5 scope: per-turn grouped diff cards in the browser + clipboard steer.
Neovim plugin and the architecture panel are planned for v1 (see `docs/PRD.md`).

## Placement

This repo lives at `~/dotfiles/.claude/tools/diff-viewer/` and is stowed to `~/.claude/tools/diff-viewer/` for cross-machine consistency.
