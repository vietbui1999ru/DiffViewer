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
  GET  /arch        →  analyzeFile() → ArchResult JSON  (lazy, per browser expand)
  GET  /stream      →  SSE to browser + Lua plugin
  GET  /            →  serve browser/index.html

browser/  (diff2html + vanilla JS, no build step)
  EventSource → per-session turn cards → turn-level layer summary bar → steer input box
  per-file card → arch section (collapsed; `a` key toggles; lazy GET /arch on first expand)

nvim/  (Lua plugin, vim.system + curl SSE client)
  vim.system curl → on_stdout parse → statusline badge
  <leader>dv       → open scratch buffer (filetype=diff, latest pending turn)
  keymaps          → q=accept-all, d=decline-file, c=steer
```

## Data shapes

### ArchResult
```js
{
  file: string,           // absolute path
  layer: 'frontend' | 'backend' | 'infra' | 'unclassified',
  forwardImports: string[],   // files this file imports (resolved paths)
  reverseImports: string[],   // files that import this file (rg results)
  importChain: ChainNode[]    // depth-limited tree, max 3 hops
}

// ChainNode — recursive, same shape at every level
{ path: string, layer: string, imports: ChainNode[] }

// ArchNode — extensible type (v1: file only)
{ type: 'file' | 'function' | 'runtime-frame', path: string, layer: string }
// v2: adds `symbol`, `calls[]`, `calledBy[]`
// v3: adds `frameId`, `calledFrom`
```

### NormalizedEvent
```js
{
  tool: 'write' | 'edit',
  path: string,
  layer: 'frontend' | 'backend' | 'infra' | 'unclassified',  // added at normalize time, free from path
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
| Arch analysis timing | Lazy, on browser expand via `GET /arch` | Avoids blocking turn-end SSE; only pays cost for files user actually inspects |
| Layer in NormalizedEvent | Added at normalize time from path | Git root + heuristics available at that point; free to compute |
| Layer heuristics | External `heuristics.json`; `.diffviewer.json` override | External = community-shareable without code change; override = non-standard layouts |
| Reverse imports | `rg <fileStem>` in git root | Fast (~50-200ms), no index, ripgrep assumed present |
| Import chain depth | Capped at 3 | Bounds `rg` call count and response time; 3 hops covers most actionable context |
| Language detection | File extension only | Sufficient for import parsing; no content sniffing needed |
| ArchNode type field | Reserved (`'file'`) but unused in v1 | Enables v2 function-level and v3 runtime-frame extension without data model rewrite |

## Staged roadmap

### v1 — File diff review + architecture panel (browser + Neovim)
- Hono server, ESM, SSE, diff2html browser rendering
- PostToolUse + Stop hooks wired globally
- Per-turn grouped diff cards in browser (per-session)
- Turn-level layer summary bar (frontend / backend / infra counts)
- Per-file architecture section: layer badge, forward imports, reverse imports, import chain (depth 3)
- `GET /arch` lazy endpoint; `a` key toggles arch section in browser
- Lua plugin: `vim.system` SSE client, scratch buffer, keymaps
- Steer: `vim.ui.input` → clipboard
- Arch analysis: TS/JS + Python + Go + Lua regex parsers; `rg` reverse lookup; `heuristics.json`

### v2 — Full turn summary + tmux injection + function-level arch
- Extend hook capture to Bash commands
- Collapsible turn groups with file tree summary
- tmux `send-keys` injection replaces clipboard
- `vim.ui.input` escalates to scratch buffer for multi-line steers
- Architecture panel: function-level call graphs via LSP or AST
- Visual graph diagram (nodes + edges) replaces text/list arch view
- Architecture section in Neovim scratch buffer

### v3 (candidate)
- Append each turn to `~/.claude/diff-history.jsonl` for cross-session replay
- Runtime trace via DAP (Debug Adapter Protocol): live data flow alongside diff review
- Open-source release: cross-platform abstraction, community heuristics defaults, configurable port

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
