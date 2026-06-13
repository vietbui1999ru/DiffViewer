# MVP-0 Mobile Companion — Implementation Spec

Implements MVP-0 of Commandr issue #1 (https://github.com/vietbui1999ru/Commandr/issues/1):
the approval loop, nothing else. A phone reviews agent diffs and approves/rejects them.
The phone is a projection and remote control — never a second source of truth.

**Revision 3** — locked decisions (operator grill, 2026-06-10):
scope = approval loop only; transport = **Tailscale-only, minimal crypto**
(single shared token, no bespoke pairing/PoP/JWT); daemon home = extend the DiffViewer
server; client = PWA pull-tool. This revision deletes the rev2 ECDH/PoP/JWT stack —
that machinery existed to survive bare-LAN-without-TLS, a scenario now explicitly out of
scope. Tailscale provides transport encryption and the trust boundary; the shared token
is a second factor. What remains from rev2 is the transport-independent correctness:
the stale-diff digest guard, the null-task approval refusal, and the symlink-hardened
token write (all carried over from the Codex council review).

Scope: (1) daemon — a loopback `:3334` listener on the existing DiffViewer server, with a
shared-token gate, a QR that ferries the URL+token to the phone, WebSocket push of
TurnSnapshots, and an approve/reject endpoint with a stale-diff digest guard;
(2) PWA — connect, render diff cards, swipe to approve/reject.

Out of scope (MVP-1+): Kanban, chat/voice task capture, GitHub proxy, native build, push
notifications, per-device tokens, multi-machine.

## 1. Constraints inherited from the bus contract (Commandr `protocol/SPEC.md` v0.1)

- **APPROVAL-1**: approval = existence of `<root>/.agents/approvals/<task-id>.approved`.
  `task-id` is the packet frontmatter `id`, never filename-derived. **Denial must never
  create the file.** Reject therefore writes nothing to the bus.
- **EVENT-3**: writers emit only defined event types. There is no `task_denied` event in
  v0.1, so the daemon writes **no events.jsonl entries at all** in MVP-0.
- **Blueprint decision #4**: no diff content, UI state, or token data ever lands in
  `.agents/`. The shared token lives daemon-local (`~/.diffviewer/`).
- **Claimed filename**: `.agents/claimed/{hostname}_{pid}_{original-filename}.md`,
  `_` separator. Task identity comes from frontmatter `id`, not the filename.

## 2. Transport posture (Tailscale-only)

The daemon binds **`127.0.0.1:3334` only**. It is never bound to a LAN/`0.0.0.0`
interface — there is no plain-HTTP-on-LAN mode.

- **Phone access (remote/real device)**: front the loopback port with
  `tailscale serve --bg 3334` (Tailscale 1.60+; serves HTTPS on `:443` by default —
  older releases used `tailscale serve --bg --https=443 127.0.0.1:3334`). Tailscale
  terminates real TLS (MagicDNS `*.ts.net` Let's
  Encrypt cert) and only tailnet members can reach it. The tailnet is the trust
  boundary; the shared token (§4) is a second factor so a stray tailnet device cannot
  approve without it.
- **Dev / same machine**: hit `http://localhost:3334/` directly. No Tailscale needed to
  build or test.

Hard dependency note for README: remote phone use requires Tailscale on both the
desktop and the phone. This is the explicit posture the operator chose; bare-LAN is not
supported.

## 3. Daemon lifecycle and module layout

- Mobile listener is **off by default**. Enabled by `--mobile` CLI flag or
  `DIFFVIEWER_MOBILE=1`. Existing `:3333` server is untouched.
- `--pair` flag (with `--mobile`): print the pairing URL (`http://localhost:3334/` for
  dev, or the operator's known `https://<host>.ts.net/` — the daemon cannot reliably
  know its own tailnet URL, so it prints the loopback URL plus instructions and encodes
  whatever `DIFFVIEWER_MOBILE_URL` is set to if provided) and a QR (via
  `qrcode-terminal`) carrying `{url, token}`. Without `--pair` the daemon still serves;
  `--pair` only controls whether the QR/token is displayed this run.

```
server.js                  — wire-up: createMobileServer() when --mobile/env set
src/sidecarWatcher.js      — 1-line change: attach `task` to snapshot (§7)
hooks/stop.sh              — resolve task id instead of hardcoding null (§7)
src/mobile/
  auth.js                  — token load/generate (file 0600 or env) + constant-time check
  approvals.js             — canonicalJson, digest (binds task), task resolution, hardened write
  wsHub.js                 — WS client set, first-frame token auth, socket caps, push fan-out
  index.js                 — createMobileServer({broadcaster, roots, options}) → {server, close()}
browser-mobile/
  index.html, app.js, style.css, manifest.webmanifest   (no client crypto)
test/
  mobile.auth.test.js, mobile.approvals.test.js,
  mobile.ws.integration.test.js, mobile.api.test.js
```

New dependencies (already installed): `ws`, `qrcode-terminal`. No JWT, no ECDH, no
AES-GCM, no client-side crypto. The only `node:crypto` uses are `randomBytes` (token),
`createHash('sha256')` (digest), and `timingSafeEqual` (token compare).

Body size cap: every JSON endpoint rejects bodies > 16 KB with 413 before parsing.

## 4. Authentication (single shared token)

`src/mobile/auth.js`:

- Token storage: `~/.diffviewer/mobile/token` (directory 0700, file 0600). On first
  `--mobile` start, if absent, generate 32 random bytes base64url and write it.
  `DIFFVIEWER_MOBILE_TOKEN` env overrides the file entirely (and is not written to disk).
  Make the home dir injectable (`options.homeDir`) for tests.
- `loadOrCreateToken(opts) -> token` and `checkToken(provided, token) -> bool` using
  `crypto.timingSafeEqual` after a length pre-check (base64url-decode both, or compare
  raw bytes — never compare via `===` on the strings).
- The token is long-lived. **Revocation = regenerate**: delete the file (or change the
  env) and restart; the phone must re-pair. No per-device tokens, no expiry, no
  blocklist in MVP-0. This is the minimal model the operator chose; document the
  tradeoff (a token leak requires regeneration) in the README.

Every REST endpoint requires `Authorization: Bearer <token>`; the WebSocket requires the
token in its first frame (§6.3). Missing/wrong → 401 (REST) / close `4401` (WS).

There is no rate limiter in MVP-0: the only reachable surface is loopback + the tailnet,
and the token is the gate. (Add one in MVP-1 if the surface widens.)

## 5. QR pairing (token transfer only)

With `--pair`, the daemon prints a QR encoding the URL
`<base>/#token=<token>` where `<base>` is `DIFFVIEWER_MOBILE_URL` if set, else
`http://localhost:3334`. Scanning it on the phone opens the PWA with the token in the URL
fragment; the PWA reads it, stores it in `localStorage`, and clears the fragment via
`history.replaceState`. (Fragments are not sent in HTTP requests and stay out of server
logs/Referer.) Manual fallback: a paste field in the PWA. No ceremony, no expiry — the
QR simply ferries the long-lived token onto the device.

## 6. Push, digest guard, approve/reject

### 6.1 Push

`src/mobile/index.js` subscribes a client to the shared broadcaster:
`{send: (snapshot) => hub.push(snapshot)}`. The hub:

- computes `digest = sha256hex(canonicalJson({sessionId, turnNumber, task, events}))`
  (`task` normalized to null when absent — the digest **binds the task id**, so an
  approval cannot be replayed against a snapshot whose task differs),
- records `latest.set(sessionId, {digest, task, turnNumber})`,
- fans out `{type: "turn", snapshot, digest}` to all **authenticated** sockets.

`canonicalJson` = JSON.stringify with recursively sorted object keys; arrays keep order
(≈15 lines in `approvals.js`, no dependency).

A late-connecting phone sees only subsequent turns — same semantics as the browser SSE
client today. The hub additionally replays the most recent `{snapshot, digest}` per
session (bounded: last 20 sessions) to a newly authenticated socket so the phone isn't
blank on connect. Daemon-memory only; vanishes on restart.

### 6.2 Approve

`POST /approve` `{sessionId, digest, taskId}`, `Authorization: Bearer <token>`.

1. Token check (§4).
2. `latest.get(sessionId)` must exist and its digest must equal `digest`, else
   `409 {error: "stale", latest: {digest, turnNumber}}` — and the daemon re-pushes the
   latest snapshot for that session over WS.
3. The latest snapshot's `task` must be **non-null and exactly equal** to `taskId`,
   else `400 {error: "task-mismatch"}`. A null-task snapshot cannot be approved through
   the API at all — without this, a digest-valid request could name any claimed task and
   get a token written.
4. `validateTaskId(taskId)`: must match `^[A-Za-z0-9._-]+$` and not be `.` or `..`
   (path-traversal defense) — else 400 before touching the filesystem.
5. Resolve the task across watch roots: for each root, scan
   `<root>/.agents/claimed/*.md` (`lstat` each; skip symlinks), parse frontmatter `id:`
   (first `id:` line between the `---` fences; trim quotes/whitespace). Exactly one root
   must contain a claimed task with `id == taskId`, else `404 {error: "task-not-claimed"}`
   (zero) or `409 {error: "ambiguous-task"}` (several — refuse, never guess).
6. Hardened token write: `lstat` `<root>/.agents` and `<root>/.agents/approvals` — each
   must be a real directory (not a symlink); create `approvals` with `mkdir` if absent.
   Write `<root>/.agents/approvals/<taskId>.approved` with flag `wx`
   (O_CREAT|O_EXCL — fails on any pre-existing path including a symlink). If the file
   already exists, return `200 {approved: true, already: true}` without touching it.
   Content: `{"approvedAt": iso8601, "digest": ...}` — APPROVAL-1 only checks existence;
   the JSON body is daemon-side audit info.
7. `200 {approved: true}` and broadcast `{type: "approved", taskId, sessionId}` to all
   sockets so a second device updates.

### 6.3 Reject

`POST /reject` — same body, same token + digest + task validation (steps 1–5). Writes
**nothing** under `.agents/` (APPROVAL-1 denial clause; EVENT-3 forbids a denial event).
Returns `200 {rejected: true}`, broadcasts `{type: "rejected", taskId, sessionId}`.
Daemon keeps an in-memory rejected set so reconnecting phones grey the card out; lost on
restart by design.

### 6.4 WebSocket auth (first-frame) and caps

`GET /ws` upgrades without credentials (browser WS cannot set headers). After upgrade the
client must send `{type: "auth", token: <token>}` within 5 s; the server sends nothing
before a valid auth frame, then replies `{type: "ready"}`. Limits:

- If an `Origin` header is present, its host must equal the request `Host` → else destroy
  pre-upgrade.
- Max 64 concurrent sockets; max 8 unauthenticated at a time; excess upgrades rejected.
- First frame max 4 KB; a first frame that is not a valid auth frame → immediate close
  `4401`.

## 7. Task-id propagation (prerequisite fix in existing code)

The sidecar schema (V0.6-SIDECAR-SPEC §1) declares `task: string|null`, but:

1. `src/sidecarWatcher.js` `ingestFile()` drops it. Fix: after
   `registry.flush(sessionId)` returns a snapshot, set
   `snapshot.task = typeof parsed.task === 'string' && parsed.task ? parsed.task : null`.
2. `hooks/stop.sh` hardcodes `task: null`. Fix: resolve the task id like the pre-commit
   gate (APPROVAL-3 order): `$AGENTS_TASK_ID` if non-empty, else branch name matching
   `agent/<task-id>` exactly (strip `agent/`), else null.
   (`adapters/opencode/diffviewer.js` keeps `task: null` for MVP-0.)

The POST `/event`/`/turn-end` legacy path produces snapshots without `task`; treat
absent as null everywhere.

## 8. PWA (`browser-mobile/`, served by the :3334 listener)

Static, no build step, no framework, **no client-side crypto** (the token is sent as-is
over the Tailscale-TLS channel). Mirrors the existing `browser/` approach.

- **Pairing screen**: read `#token=` fragment, store in localStorage, `replaceState` to
  clear it. Manual paste field as fallback. A "connected as …" / token-present indicator.
- **Review screen**: card stack, newest turn on top. Each card: session + task header,
  per-file sections from `ev.unifiedDiff` (plain `<pre>` with +/- line colouring — no
  external CDN). Tap a file header to collapse/expand.
- **Gestures**: Pointer Events. Horizontal drag past 35% of card width with a velocity
  threshold → commit; else spring back (CSS transition). Right = approve (green), left =
  reject (red). Explicit Approve/Reject buttons below the stack for accessibility —
  gestures are an enhancement, never the only path. Cards with `task: null` show the diff
  but disable approve/reject with a "no task id" note (the API enforces the same, §6.2).
- **Wire**: WS for turns + approved/rejected broadcasts; `fetch` POST for approve/reject
  with `Authorization: Bearer <token>` and the rendered card's `digest`. On 409 stale,
  drop the card and wait for the re-pushed turn. On 401, surface "token rejected —
  re-pair".
- **Connection state**: connecting/connected/disconnected banner; exponential-backoff
  reconnect (1 s → 30 s cap).
- `manifest.webmanifest` + meta tags for Add-to-Home-Screen. No service worker in MVP-0.

## 9. Testing (vitest, mirrors existing patterns — `serve({port: 0})`, real sockets)

- `mobile.auth.test.js`: generate-on-first-use writes 0600 file; reload reads same token;
  env override wins and writes nothing; `checkToken` accepts the right token and rejects
  wrong/empty/length-mismatch (constant-time path exercised).
- `mobile.approvals.test.js` (tmpdir fixtures): canonicalJson key-order stability;
  digest binds task (same events, different task → different digest); task resolution
  across 2 roots; ambiguous → error; unclaimed → error; traversal ids (`../x`, `a/b`,
  `.`) → reject; symlinked `.agents/approvals` → refused; existing token file →
  `already:true`, content untouched; happy write produces file + audit JSON.
- `mobile.ws.integration.test.js`: full loop over real sockets — start mobile server with
  a known token, connect WS, send auth frame, receive `ready` + replay, emit a snapshot
  through the broadcaster, receive the `turn` frame, POST /approve with the received
  digest, assert the token file exists; emit turn N+1 then approve with the old digest →
  409 and a fresh `turn` frame arrives; reject writes nothing (assert `.agents/` tree
  unchanged via before/after listing); unauthenticated socket receives nothing and is
  closed at 5 s (fake timers); oversized first frame → closed; Origin mismatch → rejected.
- `mobile.api.test.js`: every endpoint without/with wrong token → 401; malformed body →
  400; > 16 KB body → 413; null-task snapshot approve → 400.
- `sidecarWatcher.test.js` (extend existing): snapshot now carries `task` from the turn
  file.

## 10. Documentation deliverables (same change-set)

- `README.md`: mobile section — `--mobile`/`--pair` flags, `tailscale serve` recipe,
  localhost-for-dev, the single-token revoke-by-regenerate model and its tradeoff.
- Commandr `GUIDE.md` feature table row (separate Commandr commit).
