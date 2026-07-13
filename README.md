# DiffViewer

Real-time diff review tool for Claude Code and OpenCode. Renders agent-generated file changes as grouped diff cards in a browser tab, with steer injection between turns.

## How it works

DiffViewer is a thin UI projection over agent turns. Current inputs are:

- Claude Code hook fallback: `PostToolUse` posts file events to `/event`; `Stop` posts `/turn-end`.
- Sidecar ingestion: adapters write `<repo>/.diffviewer/turns/<sessionId>/turn-<N>.json`; the server watches those files and broadcasts diff cards over SSE.
- OpenCode plugin: captures `write`, `edit`, and `apply_patch` tool calls, then writes sidecar turns on session idle.

The browser tab receives grouped diffs via SSE and renders them with `diff2html`. Commandr remains the lifecycle source of truth; DiffViewer renders diffs, annotation/approval affordances, and architecture artifacts today; cockpit actions are the next planned layer around that bus.

See [`docs/PRD.md`](docs/PRD.md) for full requirements and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for component map.

Builder.io Agent-Native and Skills are design inputs for the next cockpit phase, not runtime dependencies. DiffViewer adopts the shared action dispatcher and visual plan/recap artifact pattern while leaving lifecycle authority in Commandr. See [`docs/BUILDERIO-FIT.md`](docs/BUILDERIO-FIT.md) and [`docs/V0.7-CONTROL-PLANE-COCKPIT-PLAN.md`](docs/V0.7-CONTROL-PLANE-COCKPIT-PLAN.md).

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

By default, steer prompts are copied to the clipboard. To send steers directly
to an OpenCode session, start OpenCode with a known server URL and pass it to
DiffViewer:

```bash
opencode --port 4096 ~/repos/Commandr
OPENCODE_SERVER_URL=http://127.0.0.1:4096 node server.js ~/repos/Commandr
```

If `OPENCODE_SERVER_PASSWORD` protects OpenCode, set the same value for
DiffViewer; `OPENCODE_SERVER_USERNAME` defaults to `opencode`.

Direct steering works only when the card carries a real OpenCode session id
(`rawSessionId` from sidecars when available, otherwise `sessionId`) that exists
on that server. Synthetic demo cards must mark themselves as `synthetic: true`;
those requests fall back to copy/paste semantics because there is no real target
agent session.

## Architecture view (Path A scaffold)

The desktop UI has an Architecture tab backed by `GET /api/architecture`. DiffViewer
does not run CodeBoarding; it reads an existing CodeBoarding artifact from
`<repo>/.codeboarding/analysis.json` and transforms the top-level component graph
to Mermaid in Node. Set `DIFFVIEWER_ARCH_PATH` to point at another artifact path.

```bash
node server.js <repo>
open http://localhost:3333
```

Open the Architecture tab after generating `analysis.json`. Missing or malformed
artifacts render inline empty/error states without affecting the diff feed.

## Neovim bridge (v0)

`nvim/diffviewer.lua` is an optional operator-lane bridge. It connects to the
desktop SSE stream, shows the latest turn in a scratch diff buffer, and can send
steer text back through `/steer`.

```lua
require('diffviewer').setup({ url = 'http://localhost:3333' })
```

Default keymap: `<leader>dv` opens the latest turn. Inside the diff buffer,
`c` sends a steer prompt and `d` declines the file under the cursor after an
explicit confirmation by running `git checkout -- <path>`.

The bridge is a local projection only. It does not own task state, approvals, or
Commandr lifecycle. Annotation-write integration is still future work.

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
# 1. Expose the loopback port to your tailnet with real TLS
#    (Tailscale 1.60+; serves HTTPS on :443 by default):
tailscale serve --bg 3334

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

This repo is a standalone checkout at `~/repos/DiffViewer/`. It is wired into the
agent toolchain by symlink (e.g. `~/.config/opencode/plugins/diffviewer.js` →
`~/repos/DiffViewer/adapters/opencode/diffviewer.js`), not by being stowed from
dotfiles — clone it under `~/repos/` before running the dotfiles OpenCode setup.
