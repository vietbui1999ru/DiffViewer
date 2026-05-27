# Architecture

## Component map

```
Claude Code
  PostToolUse hook  →  curl POST :3333/event     (Write|Edit|MultiEdit, includes $CLAUDE_SESSION_ID)
  Stop hook         →  curl POST :3333/turn-end   (turn boundary, includes $CLAUDE_SESSION_ID)

~/.claude/tools/diff-viewer/server.js  (Hono, ESM, Node 20+, always-running daemon)
  POST /event       →  normalize → buffer into session TurnBuffer
  POST /turn-end    →  flush session buffer → SSE broadcast (skip if empty)
  POST /steer       →  pbcopy (v1) / tmux send-keys (v2)
  GET  /stream      →  SSE to browser + Lua plugin
  GET  /            →  serve browser/index.html

browser/  (diff2html + vanilla JS, no build step)
  EventSource → per-session turn cards → steer input box

nvim/  (Lua plugin, vim.system + curl SSE client)
  vim.system curl → on_stdout parse → statusline badge
  <leader>dv       → open scratch buffer (filetype=diff, latest pending turn)
  keymaps          → q=accept-all, d=decline-file, c=steer
```

## Data shapes

### NormalizedEvent
```js
{
  tool: 'write' | 'edit',
  path: string,
  unifiedDiff: string,   // pre-computed by server via diff pkg, ready for diff2html
  isNew: boolean,        // true = all-green new file (git show returned empty)
  seq: number,           // order within turn
  ts: number             // epoch ms
}
```

### TurnSnapshot
```js
{
  sessionId: string,
  turnNumber: number,    // per-session counter
  events: NormalizedEvent[],
  startedAt: number,
  completedAt: number
}
```

## Key implementation decisions

| Decision | Choice | Reason |
|---|---|---|
| Write old content | `git show HEAD:<path>` | PostToolUse fires after write; filesystem already modified |
| Edit old content | `oldString` from tool JSON | Available directly, no file read needed |
| Diff computation | Server-side (`diff` npm pkg) | `unifiedDiff` string is testable; browser just renders |
| Concurrent sessions | `Map<sessionId, TurnBuffer>` keyed on `$CLAUDE_SESSION_ID` | Prevents interleaved diffs from two Claude windows |
| Empty turns | Skip emit silently | Stop fires on text-only turns; nothing to review |
| MultiEdit | Expand to N NormalizedEvents | One diff card per edit, not one per tool call |

## Staged roadmap

### v1 — File diff review (browser + Neovim)
- Hono server, ESM, SSE, diff2html browser rendering
- PostToolUse + Stop hooks wired globally
- Per-turn grouped diff cards in browser (per-session)
- Lua plugin: `vim.system` SSE client, scratch buffer, keymaps
- Steer: `vim.ui.input` → clipboard

### v2 — Full turn summary + tmux injection
- Extend hook capture to Bash commands
- Collapsible turn groups with file tree summary
- tmux `send-keys` injection replaces clipboard
- `vim.ui.input` escalates to scratch buffer for multi-line steers

### v3 (candidate)
- Append each turn to `~/.claude/diff-history.jsonl` for cross-session replay

## Neovim keymaps

| Key | Action |
|---|---|
| `q` / `<Esc>` | Accept all — close diff buffer |
| `d` | Decline file under cursor — `git checkout HEAD -- <path>` |
| `c` | Steer — `vim.ui.input` prompt → POST /steer → clipboard |
| `<leader>dv` | Open latest pending turn scratch buffer |

Cursor position maps to file via `diff --git a/<path>` header line parsing.

## Placement

`~/dotfiles/.claude/tools/diff-viewer/` stowed to `~/.claude/tools/diff-viewer/`.
Lua plugin at `~/dotfiles/nvim/lua/diffviewer.lua` stowed into Neovim config.
Hooks registered globally in `~/.claude/settings.json` — active in every project.
Daemon: `tmux new-window -n diff-viewer 'node ~/.claude/tools/diff-viewer/server.js'`
`node_modules/` gitignored; `npm install` in machine bootstrap.
