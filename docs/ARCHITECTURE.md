# Architecture

## Component map

```
Agent harnesses
  Claude Code hooks        → POST /event + /turn-end fallback transport
  OpenCode plugin          → .diffviewer/turns/<sessionId>/turn-<N>.json sidecars
  Pi extension             → interactive worker diff review and decision artifacts

server.js  (Hono, ESM, Node 20+, always-running daemon)
  sidecarWatcher           → watch <repo>/.diffviewer/turns/ → normalize → SSE broadcast
  POST /event              → legacy/test fallback: normalize → TurnBuffer
  POST /turn-end           → legacy/test fallback: flush TurnBuffer
  POST /steer              → clipboard fallback or OpenCode prompt_async when configured
  GET  /api/architecture   → CodeBoarding analysis.json → Mermaid graph JSON
  GET  /stream             → SSE to browser + Lua/mobile clients
  GET  /                   → serve browser/index.html

browser/  (diff2html + vanilla JS, no build step)
  EventSource              → per-session turn cards → steer input box
  Architecture tab         → GET /api/architecture → Mermaid graph

mobile/  (optional loopback :3334 PWA)
  Tailscale-only approval loop → Commandr approval token
```

DiffViewer is L5 in the Commandr 5-layer model. It can cache, render, and propose actions, but authoritative task lifecycle remains in Commandr `.agents/`.

## Data shapes

### ArchitectureView
```js
{
  mermaid: string,
  meta: {
    repoName: string,
    generatedAt: string,
    commitHash: string,
    componentCount: number,
    relationCount: number,
    expandableCount: number
  },
  path: string
}
```

### NormalizedEvent
```js
{
  tool: 'write' | 'edit',
  path: string,
  unifiedDiff: string,   // pre-computed by server via diff pkg, ready for diff2html
  isNew: boolean         // true = oldContent was empty
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

### v0.5 — File diff review + architecture panel (browser + Neovim)
- Hono server, ESM, SSE, diff2html browser rendering
- PostToolUse + Stop hooks wired globally
- Per-turn grouped diff cards in browser (per-session)
- Turn-level layer summary bar (frontend / backend / infra counts)
- Per-file architecture section: layer badge, forward imports, reverse imports, import chain (depth 3)
- `GET /arch` lazy endpoint; `a` key toggles arch section in browser
- Lua plugin: `vim.system` SSE client, scratch buffer, keymaps
- Steer: `vim.ui.input` → clipboard
- Arch analysis: TS/JS + Python + Go + Lua regex parsers; `rg` reverse lookup; `heuristics.json`

### v0.6 — Sidecar ingestion and harness re-home
- DiffViewer watches `.diffviewer/turns/` sidecars instead of depending on Claude Code hooks
- OpenCode adapter writes turn snapshots on idle
- Server consumes sidecar files as queue items and unlinks them after successful broadcast
- Legacy `/event` and `/turn-end` remain as fallback/test seam

### v0.6.1 — Direct OpenCode steering
- Clipboard remains fallback
- If `OPENCODE_SERVER_URL` is set, `/steer` sends to OpenCode `POST /session/:id/prompt_async`
- Requires the card `sessionId` to be the actual OpenCode session id
- Synthetic/demo cards cannot be direct-steered because no target agent session exists

### v0.7+ — Control-plane cockpit
- Agent-Native-style action registry: UI clicks and agent requests share named, schema-validated actions
- Review/evidence package artifacts generated from TurnSnapshots, Commandr events, approvals, and council verdicts
- Runner panel that can display `commandr-omp-runner` sessions without making omp the bus
- Tauri shell after the action registry and artifact store stabilize
- Full plan: `docs/V0.7-CONTROL-PLANE-COCKPIT-PLAN.md`

## Neovim keymaps

| Key | Action |
|---|---|
| `q` / `<Esc>` | Accept all — close diff buffer |
| `d` | Decline file under cursor — `git checkout HEAD -- <path>` |
| `c` | Steer — `vim.ui.input` prompt → POST /steer → clipboard or OpenCode direct steer |
| `<leader>dv` | Open latest pending turn scratch buffer |

Cursor position maps to file via `diff --git a/<path>` header line parsing.

## Placement

`~/dotfiles/.claude/tools/diff-viewer/` stowed to `~/.claude/tools/diff-viewer/`.
Lua plugin at `~/dotfiles/nvim/lua/diffviewer.lua` stowed into Neovim config.
Hooks registered globally in `~/.claude/settings.json` — active in every project.
Daemon: `tmux new-window -n diff-viewer 'node ~/.claude/tools/diff-viewer/server.js'`
`node_modules/` gitignored; `npm install` in machine bootstrap.
