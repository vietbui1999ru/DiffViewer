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

## Mobile companion (MVP-0)

A phone-facing approval loop: review an agent's per-turn diff on your phone and
swipe to approve or reject. Approving writes the Commandr bus approval token
(`.agents/approvals/<task-id>.approved`) that unblocks the agent's commit gate;
rejecting writes nothing. The phone is a projection and remote control, never a
second source of truth. Full design: [`docs/MVP0-MOBILE-SPEC.md`](docs/MVP0-MOBILE-SPEC.md).
Implements MVP-0 of Commandr issue #1.

### Enable

```bash
node server.js --mobile <repo>        # adds a loopback :3334 listener
node server.js --mobile --pair <repo> # also prints the pairing URL + QR
```

The mobile listener binds `127.0.0.1:3334` only — never a LAN interface. For
same-machine development, open `http://localhost:3334/` directly (no Tailscale
needed).

### Pair a real phone (over Tailscale)

The transport posture is **Tailscale-only**: Tailscale provides TLS + the tailnet
trust boundary, and a single shared token is the second factor. Browsers can't pin
self-signed certs, so plain-HTTP-on-LAN is intentionally unsupported.

```bash
# 1. Expose the loopback port to your tailnet with real TLS:
tailscale serve --bg --https=443 127.0.0.1:3334

# 2. Tell the daemon its public URL, then print the pairing QR:
DIFFVIEWER_MOBILE_URL=https://<your-host>.ts.net node server.js --mobile --pair <repo>
```

3. On the phone (with the Tailscale app connected to the same tailnet), scan the
   QR. It opens the PWA at `https://<your-host>.ts.net/#token=<token>`; the page
   stores the token and clears it from the URL.
4. When an agent finishes a turn, its diff appears as a card. Swipe right to
   approve, left to reject (or use the explicit buttons).

### Token and revocation

The shared token is generated on first `--mobile` start at
`~/.diffviewer/mobile/token` (file `0600`). Set `DIFFVIEWER_MOBILE_TOKEN` to
override it from the environment (not written to disk). The token is long-lived;
**to revoke, delete the file (or change the env var) and restart** — the phone
must then re-pair. There are no per-device tokens in MVP-0.

### Scope

MVP-0 is the approval loop only. Kanban, voice/chat task capture, a GitHub proxy,
native push, and per-device tokens are deferred to MVP-1+. The desktop chain
(sidecar → diff card → approve → bus token → commit gate) is verified end-to-end;
the physical-phone + Tailscale leg is operator-driven per the steps above.

## Placement

This repo lives at `~/dotfiles/.claude/tools/diff-viewer/` and is stowed to `~/.claude/tools/diff-viewer/` for cross-machine consistency.
