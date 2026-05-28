# PRD: Agent Diff Viewer

## Problem Statement

When Claude Code generates code across multiple tool calls in a single turn, there is no native UI to review the full set of file changes before continuing. Changes appear only in terminal scroll or must be manually inspected via `git diff` after the fact. This makes it difficult to catch errors, understand the scope of a turn's output, or redirect the agent before it continues down the wrong path.

## Solution

A persistent localhost server that receives Claude Code hook events, groups file changes by agent turn, and renders them as diff cards in both a browser tab and a Neovim scratch buffer. After reviewing a completed turn's diffs, the user can accept, decline per-file, or type a steer to redirect Claude — all without leaving the terminal.

## User Stories

1. As a developer, I want to see all files changed in a Claude Code turn grouped together, so that I can review the full scope of changes before continuing.
2. As a developer, I want diffs rendered with syntax highlighting and line-level change indicators, so that I can read changes quickly without opening each file.
3. As a developer, I want new turns to appear automatically without refreshing, so that the review loop is frictionless.
4. As a developer, I want to know when a Claude turn has finished vs is still in progress, so that I know when to begin reviewing.
5. As a developer, I want to type a steer prompt and have it copied to my clipboard, so that I can paste it into the Claude terminal immediately.
6. As a developer, I want the diff viewer to work across all my projects without per-project configuration, so that I don't have to set it up per repo.
7. As a developer, I want the diff viewer to run as a background daemon, so that it is always ready when I start a Claude session.
8. As a developer, I want the daemon to fail silently when not running, so that Claude Code sessions work normally without it.
9. As a developer, I want the tool to work on every machine I run my dotfiles bootstrap on, so that my workflow is consistent across machines.
10. As a developer, I want Write, Edit, and MultiEdit tool calls all captured, so that no file change goes unreviewed.
11. As a developer, I want each turn's diff group to show which files were changed and how many lines were added/removed, so that I can triage large turns at a glance.
12. As a developer, I want diff cards to be collapsible, so that I can focus on the files I care about.
13. As a developer, I want new file creations distinguished from modifications visually, so that I understand the nature of each change.
14. As a developer, I want the browser tab title to update with the turn count, so that I know there are new diffs without switching focus.
15. As a developer running two Claude sessions simultaneously, I want diffs from each session kept separate, so that I don't see garbled mixed output.
16. As a Neovim user, I want a statusline badge showing pending turns, so that I know to review without being interrupted mid-edit.
17. As a Neovim user, I want `<leader>dv` to open the latest pending turn as a scratch buffer, so that I can review diffs without leaving the terminal.
18. As a Neovim user, I want `d` to decline a file and revert it to the last commit, so that I can undo a specific change inline.
19. As a Neovim user, I want `c` to open a steer prompt, so that I can redirect Claude without switching to a browser.
20. As a Neovim user, I want `q` to accept the whole turn and close the buffer, so that review dismissal is a single keystroke.
21. As a developer (v2), I want my steer injected directly into the Claude terminal via tmux, so that I don't need to manually paste.
22. As a developer (v2), I want Bash commands shown alongside file diffs in the same turn group, so that I have full context of what the agent did.
23. As a developer, I want each changed file's diff card to show which architectural layer it belongs to (frontend / backend / infra / unclassified), so that I understand what part of the system was touched.
24. As a developer, I want to expand an "Architecture" section on any diff card to see what the changed file imports and what imports it, so that I understand its dependencies without opening the file.
25. As a developer, I want to see a depth-limited import chain (file → its imports → their imports, max 3 hops) for each changed file, so that I can trace the execution path from the changed file downward.
26. As a developer, I want a turn-level layer summary bar showing how many files were changed per layer (e.g. "frontend: 2, backend: 3, infra: 0"), so that I can triage the architectural scope of a turn at a glance.
27. As a developer, I want the architecture section to be collapsed by default and toggled with the `a` key, so that it doesn't clutter my diff review unless I need it.
28. As a developer, I want the architecture analysis to appear within 200ms of expanding a diff card, so that it doesn't interrupt my review flow.
29. As a developer, I want the tool to work across TS/JS, Python, Go, and Lua codebases with zero config, so that it is useful regardless of which project Claude is editing.
30. As a developer, I want to optionally place a `.diffviewer.json` at a project's git root to override the default layer heuristics, so that non-standard directory structures are supported.
31. As a developer, I want files with unsupported extensions to still show a layer badge and path, so that the architecture panel degrades gracefully.
32. As a developer (v2), I want function-level call graphs shown in the architecture section, so that I can see which specific functions are affected by a change.
33. As a developer (v3), I want a runtime trace view showing live data flow when a debug session is active, so that I can observe actual execution paths alongside the diff.

## Implementation Decisions

### Modules

**Turn Buffer** — pure in-memory accumulator, no I/O
- `add(event: NormalizedEvent): void`, `flush(): TurnSnapshot`, `reset(): void`
- One TurnBuffer per session, stored in `Map<sessionId, TurnBuffer>`
- Resets after each flush; no cross-turn state

**Event Receiver** — POST /event + POST /turn-end
- Reads `sessionId` from request body (sourced from `$CLAUDE_SESSION_ID` in hook)
- Normalizes Write/Edit/MultiEdit into `NormalizedEvent` with pre-computed `unifiedDiff`
- Write old content: `git show HEAD:<path>` (empty string = new file)
- Edit old content: `oldString` from tool JSON directly
- MultiEdit: expands to N NormalizedEvents, one per edit
- `/turn-end`: flush session buffer → skip if empty → broadcaster.emit(snapshot)

**Event Normalizer** — pure function, no I/O
- Input: raw tool JSON + old content string
- Output: `NormalizedEvent` with `unifiedDiff` via `diff.createPatch()`
- Testable in isolation with no server context

**SSE Broadcaster** — manages EventSource connections
- `subscribe(res)`, `unsubscribe(res)`, `emit(snapshot: TurnSnapshot)`
- Cleans up disconnected clients on emit

**Steer Handler** — POST /steer
- v1: `{ sessionId, text }` → `echo text | pbcopy`
- v2: additionally writes to `~/.claude/pending-steer.md` + `tmux send-keys`

**Arch Analyzer** — pure function, no I/O
- `analyzeFile(filePath, gitRoot, heuristics): ArchResult`
- Derives language from file extension; dispatches to per-language import regex parser
- Forward imports: parse file's import statements → list of resolved paths
- Reverse imports: `rg "<fileStem>" --type <lang> <gitRoot>` → filter to import lines
- Import chain: recursive forward parse capped at depth 3
- Layer: walk path segments against `heuristics.json`; first match wins; fallback = `unclassified`
- Supported: `.ts`, `.tsx`, `.js`, `.jsx` / `.py` / `.go` / `.lua`; unsupported = layer only, no imports

**Arch Route** — `GET /arch?file=<path>`
- Derives git root: `git -C <dir> rev-parse --show-toplevel`
- Loads heuristics: project `.diffviewer.json` if present, else built-in `heuristics.json`
- Calls `analyzeFile()` → returns `ArchResult` JSON
- Response time target: <200ms for projects up to ~500 files

**Heuristics Config** — `heuristics.json` (built-in, external file, community-shareable)
- Default layer→path-segment mappings: `frontend`, `backend`, `infra`
- Per-project override: `.diffviewer.json` at git root (optional, never required)

**Static Server** — serves browser/ from Hono; no build step

**Browser UI** — vanilla JS + diff2html (CDN)
- EventSource client → per-session turn cards
- Turn-level layer summary bar: "frontend: N  backend: N  infra: N  unclassified: N" (derived from TurnSnapshot layer data)
- Collapsible per-file diffs; Write vs Edit visually distinguished
- Architecture section per file card: collapsed by default, `a` key toggles; lazy `GET /arch?file=` on first expand
- Architecture section content: layer badge, forward imports list, reverse imports list, import chain tree (depth 3)
- Steer input box; Send → POST /steer
- Tab title: `(N) Diff Viewer`

**Neovim Lua Plugin** — `nvim/lua/diffviewer.lua`
- `vim.system({'curl','-sN','http://localhost:3333/stream'}, {text=true, on_stdout=…})`
- Parses `data: <json>` lines, decodes TurnSnapshot
- Maintains pending turn queue per session
- Statusline component: `[DV: N]` when pending turns > 0
- `<leader>dv`: opens scratch buffer (`filetype=diff`) with latest turn's unified diffs
- File header parsing: `diff --git a/<path>` → maps cursor position to file path
- Keymaps (buffer-local): `q`=accept+close, `d`=decline file, `c`=steer via `vim.ui.input`
- `vim.ui.input` cancel → opens multi-line scratch buffer input (v2 escalation path)
- Auto-reconnect: `vim.defer_fn` retry on `vim.system` process exit

**Hook Scripts**
- `hooks/post-tool-use.sh`: reads `$CLAUDE_TOOL_NAME`, `$CLAUDE_TOOL_INPUT_JSON`, `$CLAUDE_SESSION_ID`; runs `git show HEAD:<path>` for Write; POSTs to `/event`; exits 0 always
- `hooks/stop.sh`: POSTs `{ sessionId }` to `/turn-end`; exits 0 always
- Both: `curl -sf --max-time 1` (fail fast, fail silent when server down)

**Install Script** — `scripts/install.sh`
- Idempotently patches `~/.claude/settings.json`: adds PostToolUse (matcher `Write|Edit|MultiEdit`) and Stop hook entries
- Merges into existing hook arrays; never overwrites
- Creates `~/.claude/settings.json` with empty scaffold if missing

### Architecture decisions

- Arch analysis: on-demand per file, lazy (browser fetches `GET /arch` on expand, not pushed via SSE)
- Reverse import lookup: `rg` (ripgrep); fallback `grep -r` not implemented in v1
- Language detection: file extension only; no content sniffing
- Heuristics: external `heuristics.json` file (not hardcoded); `.diffviewer.json` project override optional
- Import chain depth: capped at 3 hops to bound `rg` calls and response time
- Layer in TurnSnapshot: server adds `layer` field to each `NormalizedEvent` at normalize time (free — path is known); turn-level counts derived in browser from event list
- A→C extensibility: `ArchNode` type field (`'file' | 'function' | 'runtime-frame'`) reserved but unused in v1

- Port: `3333` (hardcoded, no config in v1)
- Runtime: Node 20+, ESM (`"type": "module"`), Vitest for tests
- Stateless across restarts; no turn history persistence in v1
- Hook paths: absolute `~/.claude/tools/diff-viewer/hooks/`
- Concurrent sessions: `Map<sessionId, TurnBuffer>`, GC'd on Stop
- Empty turns (Stop with no buffered events): skip emit silently

## Testing Decisions

Tests verify external behavior through the public interface — not internal state, not implementation details.

| Module | What to test |
|---|---|
| Turn Buffer | add+flush returns ordered events; empty flush returns empty snapshot; reset starts fresh; seq numbers increment |
| Event Normalizer | Write payload → correct NormalizedEvent + unifiedDiff; Edit → correct shape; MultiEdit → N events; new file (empty old) → all-green diff |
| Event Receiver | Unknown tool dropped; /turn-end triggers flush+emit (stub broadcaster); empty flush skipped; session isolation (two sessions don't mix) |
| SSE Broadcaster | subscribe adds connection; emit writes SSE; disconnected client cleaned up; multiple subscribers all receive |
| Steer Handler | Valid text → pbcopy invoked with correct input; empty text → 400 |
| Browser UI | turn-complete SSE renders new card; Send POSTs + clears input; tab title updates; collapse/expand toggle; layer summary bar shows correct counts; arch section renders on expand; `a` key toggles arch section |
| Arch Analyzer | TS import → correct forwardImports; Python `from X import Y` → resolved path; Go `import "pkg"` → path list; unknown extension → layer only, no imports; depth-3 chain stops at 3 hops; `.diffviewer.json` overrides built-in heuristics |
| Arch Route | `GET /arch?file=` returns ArchResult JSON; derives git root correctly; missing rg → 503 with clear error; <200ms for ≤500 file project |
| Lua Plugin | (manual) badge appears on turn arrival; `<leader>dv` opens buffer; `d` reverts file; `c` opens input |

## Out of Scope

- Git history traversal (use lazygit / Fugitive)
- Mid-turn agent interruption
- Diff history persistence across restarts (v3 candidate)
- Bash command capture in turn groups (v2)
- tmux injection (v2)
- Multi-line steer scratch buffer (v2 escalation from `vim.ui.input`)
- Windows/Linux support (macOS `pbcopy` assumed for v1)
- Auth or network exposure (localhost only)
- Function-level call graphs (v2 arch extension)
- Runtime trace / DAP integration (v3 arch extension)
- Visual graph diagram with nodes and edges (v2 — v1 uses text/list only)
- Architecture section in Neovim scratch buffer (v2 — v1 browser only)

## Further Notes

- Existing `PostToolUse` hook uses `Write|Edit|MultiEdit` matcher for lint protection — diff viewer adds a second entry under same matcher, evaluated independently by Claude Code
- `diff2html` from CDN keeps the browser bundle dependency-free
- Steer only touches clipboard — Claude's context window and conversation state untouched
- Placement: `~/dotfiles/.claude/tools/diff-viewer/` stowed to `~/.claude/tools/diff-viewer/`; Lua plugin at `~/dotfiles/nvim/lua/diffviewer.lua`
