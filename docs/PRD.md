# PRD: Agent Diff Viewer

## Problem Statement

When Claude Code generates code across multiple tool calls in a single turn, there is no native UI to review the full set of file changes before continuing. Changes appear only in terminal scroll or must be manually inspected via `git diff` after the fact. This makes it difficult to catch errors, understand the scope of a turn's output, or redirect the agent before it continues down the wrong path.

## Solution

A persistent localhost server that receives Claude Code hook events, groups file changes by agent turn, and renders them as diff cards in a browser tab. After reviewing a completed turn's diffs, the user can type a steer in the browser — the text is copied to clipboard for immediate paste into the Claude Code terminal.

## User Stories

1. As a developer, I want to see all files changed in a Claude Code turn grouped together, so that I can review the full scope of changes before continuing.
2. As a developer, I want diffs rendered with syntax highlighting and line-level change indicators, so that I can read changes quickly without opening each file.
3. As a developer, I want new turns to appear in the browser automatically without refreshing, so that the review loop is frictionless.
4. As a developer, I want to know when a Claude turn has finished (vs is still in progress), so that I know when to begin reviewing.
5. As a developer, I want to type a steer prompt in the browser UI and have it copied to my clipboard, so that I can paste it into the Claude terminal immediately.
6. As a developer, I want the diff viewer to work across all my projects without per-project configuration, so that I don't have to set it up per repo.
7. As a developer, I want the diff viewer to run as a background daemon, so that it is always ready when I start a Claude session.
8. As a developer, I want the daemon to fail silently when not running, so that Claude Code sessions work normally without it.
9. As a developer, I want the tool to work on every machine I run my dotfiles bootstrap on, so that my workflow is consistent across machines.
10. As a developer, I want Write, Edit, and MultiEdit tool calls all captured, so that no file change goes unreviewed.
11. As a developer, I want each turn's diff group to show which files were changed and how many lines were added/removed, so that I can triage large turns at a glance.
12. As a developer, I want diff cards to be collapsible, so that I can focus on the files I care about.
13. As a developer, I want the steer input to be pre-focused when a turn completes, so that I can type immediately without clicking.
14. As a developer, I want to see new file creations (Write) distinguished from modifications (Edit/MultiEdit) visually, so that I understand the nature of each change.
15. As a developer, I want the browser tab title to update with the turn count, so that I know there are new diffs without switching focus.
16. As a developer (v2), I want my steer to be injected directly into the Claude terminal via tmux, so that I don't need to manually paste.
17. As a developer (v2), I want to see Bash commands run by Claude alongside file diffs in the same turn group, so that I have full context of what the agent did.

## Implementation Decisions

### Modules

**Turn Buffer** — pure in-memory accumulator, no I/O
- `add(event: NormalizedEvent): void`, `flush(): TurnSnapshot`, `reset(): void`
- Resets after each flush; no cross-turn state

**Event Receiver** — POST /event + POST /turn-end
- Normalizes Write/Edit/MultiEdit into unified `NormalizedEvent`
- MultiEdit expands to N individual Edit events
- `/turn-end` triggers flush → broadcaster.emit

**SSE Broadcaster** — manages EventSource connections
- `subscribe(res)`, `unsubscribe(res)`, `emit(snapshot)`
- Cleans up disconnected clients on emit

**Steer Handler** — POST /steer
- v1: `pbcopy` (macOS clipboard)
- v2: write to `~/.claude/pending-steer.md` + `tmux send-keys`

**Static Server** — serves browser/ from Hono; no build step

**Browser UI** — vanilla JS + diff2html (CDN)
- SSE client → per-turn grouped diff cards
- Collapsible per-file diffs, Write vs Edit visually distinguished
- Steer input box pre-focused on turn completion; Send → POST /steer
- Tab title: `(N) Diff Viewer`

**Hook Scripts**
- `hooks/post-tool-use.sh`: curl POST /event on Write|Edit|MultiEdit; exit 0 always
- `hooks/stop.sh`: curl POST /turn-end; exit 0 always
- Both: `curl -sf --max-time 1` (fail fast, fail silent)

**Install Script** — idempotently patches `~/.claude/settings.json`; merges hooks, never overwrites

### Architecture

- Port: `3333` (hardcoded, no config in v1)
- Stateless across restarts; no turn history persistence in v1
- Hook paths: absolute `~/.claude/tools/diff-viewer/hooks/`
- Daemon: `tmux new-window -n diff-viewer 'node ~/.claude/tools/diff-viewer/server.js'`
- `node_modules/` gitignored; `npm install` in machine bootstrap
- Placement: `~/dotfiles/.claude/tools/diff-viewer/` stowed to `~/.claude/tools/diff-viewer/`

## Testing Decisions

Tests verify external behavior through the public interface only — not internal state, not implementation details.

| Module | What to test |
|---|---|
| Turn Buffer | add+flush sequence; empty flush; reset after flush; MultiEdit expansion count |
| Event Receiver | Write/Edit/MultiEdit → correct NormalizedEvent; unknown tool dropped; /turn-end triggers flush+emit |
| SSE Broadcaster | subscribe adds connection; emit writes SSE; disconnected client cleaned up; multiple subscribers all receive |
| Steer Handler | valid text → pbcopy invoked; empty text → 400 |
| Browser UI | turn-complete SSE renders card; Send POSTs + clears input; tab title updates; collapse/expand toggle |

## Out of Scope

- Git history traversal (use lazygit / Fugitive)
- Mid-turn agent interruption
- Diff history persistence across restarts (v3 candidate)
- Bash command capture (v2)
- tmux injection (v2)
- Windows/Linux support (v1 is macOS only)
- Auth or network exposure (localhost only)

## Further Notes

- Existing `PostToolUse` hook uses `Write|Edit|MultiEdit` matcher for lint protection — diff viewer adds a second entry under same matcher, evaluated independently
- `diff2html` from CDN keeps bundle dependency-free for a local tool
- Steer input only touches clipboard — Claude's context window and conversation state untouched
