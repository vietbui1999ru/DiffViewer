/**
 * DiffViewer Mobile PWA — app.js
 *
 * No framework, no build step, no client-side crypto.
 * Token sent as-is over Tailscale-TLS channel (§8).
 *
 * Sections:
 *   1. State
 *   2. Token management (localStorage + fragment)
 *   3. Connection (WS + exp-backoff reconnect)
 *   4. Message handlers
 *   5. Card rendering
 *   6. Gesture controller (Pointer Events)
 *   7. Approve / reject actions
 *   8. UI helpers
 */

// ──────────────────────────────────────────
// 1. State
// ──────────────────────────────────────────

const LS_TOKEN_KEY = 'dv_mobile_token';
const SWIPE_THRESHOLD = 0.35;   // 35% of card width
const SWIPE_VELOCITY  = 0.3;    // px/ms
const BACKOFF_MIN     = 1000;
const BACKOFF_MAX     = 30000;

let token = null;
let ws    = null;
let reconnectTimer = null;
let backoffMs = BACKOFF_MIN;

// Map<sessionId_turnNumber, {snapshot, digest, el}>
const cards = new Map();

// ──────────────────────────────────────────
// 2. Token management
// ──────────────────────────────────────────

function loadToken() {
  // Fragment takes priority — QR pairing
  const hash = location.hash;
  if (hash.startsWith('#token=')) {
    const t = hash.slice(7);
    if (t) {
      localStorage.setItem(LS_TOKEN_KEY, t);
      history.replaceState(null, '', location.pathname + location.search);
      return t;
    }
  }
  return localStorage.getItem(LS_TOKEN_KEY) || null;
}

function saveToken(t) {
  localStorage.setItem(LS_TOKEN_KEY, t);
  token = t;
}

function clearToken() {
  localStorage.removeItem(LS_TOKEN_KEY);
  token = null;
}

// ──────────────────────────────────────────
// 3. Connection — WS + exp-backoff
// ──────────────────────────────────────────

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function connect() {
  if (!token) return;

  setBanner('connecting');

  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', (ev) => {
    ws = null;
    setBanner('disconnected');
    // 4401 = auth rejected
    if (ev.code === 4401) {
      showTokenError();
      return; // don't reconnect on auth failure
    }
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // close event will fire after error; reconnect handled there
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX);
    connect();
  }, backoffMs);
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.close(); ws = null; }
}

// Force an immediate reconnect on foreground / network-restore. iOS suspends the
// socket AND the backoff timer while the PWA is backgrounded, so a timer-driven
// reconnect can stall up to BACKOFF_MAX (or never fire if 'close' was missed).
// visibilitychange/online are delivered on resume, so we reset backoff and
// reconnect now. A still-OPEN/CONNECTING socket is left alone (no wasteful churn).
// Known limitation: a "zombie" socket that reads OPEN after resume isn't replaced
// here — that needs a heartbeat (deferred, Fork 4 reconnect hardening).
function reconnectNow() {
  if (!token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  backoffMs = BACKOFF_MIN;
  connect();
}

// ──────────────────────────────────────────
// 4. Message handlers
// ──────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case 'ready':
      setBanner('connected');
      backoffMs = BACKOFF_MIN;
      break;
    case 'turn':
      handleTurn(msg.snapshot, msg.digest);
      break;
    case 'approved':
      markCard(msg.sessionId, 'approved');
      break;
    case 'rejected':
      markCard(msg.sessionId, 'rejected');
      break;
    case 'undo':
      unMarkCard(msg.sessionId);
      break;
  }
}

function cardKey(snapshot) {
  return `${snapshot.sessionId}`;
}

function handleTurn(snapshot, digest) {
  const key = cardKey(snapshot);

  // Replace existing card for session (re-pushed turn)
  if (cards.has(key)) {
    const old = cards.get(key);
    old.el.remove();
    cards.delete(key);
  }

  const el = buildCard(snapshot, digest);
  const entry = { snapshot, digest, el };
  cards.set(key, entry);

  const stack = document.getElementById('review-screen');
  const empty = document.getElementById('empty-state');
  if (empty) empty.remove();

  // newest on top = prepend
  stack.insertBefore(el, stack.firstChild);
  attachGesture(el, entry);
}

function markCard(sessionId, state) {
  const entry = cards.get(sessionId);
  if (!entry) return;
  // Lock the card against further decisions. Covers the local submit path AND a
  // decision broadcast from another device over WS.
  entry.decided = true;
  const overlay = entry.el.querySelector('.card-dismissed');
  if (!overlay) return;
  overlay.className = `card-dismissed ${state} show`;
  // Disable action buttons
  for (const btn of entry.el.querySelectorAll('.card-actions button')) {
    btn.disabled = true;
  }
}

// Revert a decision (undo): hide the overlay, unlock the gesture, re-enable the
// action buttons. Driven by the {type:'undo'} broadcast (so every device reverts)
// and optimistically by submitUndo.
function unMarkCard(sessionId) {
  const entry = cards.get(sessionId);
  if (!entry) return;
  entry.decided = false;
  const overlay = entry.el.querySelector('.card-dismissed');
  if (overlay) overlay.className = 'card-dismissed';
  const hasTask = !!entry.snapshot.task;
  for (const btn of entry.el.querySelectorAll('.card-actions button')) {
    btn.disabled = !hasTask;
  }
}

async function submitUndo(snapshot) {
  if (!token) return;
  if (!snapshot.task) return;
  let res;
  try {
    res = await fetch('/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sessionId: snapshot.sessionId, taskId: snapshot.task }),
    });
  } catch {
    return; // network failure — the WS undo broadcast reconciles on reconnect
  }
  if (res.ok) {
    // Optimistic local revert; the server also broadcasts {type:'undo'} (idempotent).
    unMarkCard(snapshot.sessionId);
  }
}

// ──────────────────────────────────────────
// 5. Card rendering
// ──────────────────────────────────────────

function buildCard(snapshot, digest) {
  const wrap = document.createElement('div');
  wrap.className = 'card-wrap';
  wrap.dataset.sessionId = snapshot.sessionId;
  wrap.dataset.digest = digest;

  const card = document.createElement('div');
  card.className = 'card';

  // -- Header --
  const hdr = document.createElement('div');
  hdr.className = 'card-header';

  const sessionEl = document.createElement('div');
  sessionEl.className = 'card-session';
  sessionEl.textContent = snapshot.sessionId;

  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const taskEl = document.createElement('span');
  taskEl.className = 'card-task' + (snapshot.task ? '' : ' null-task');
  taskEl.textContent = snapshot.task ?? '(no task)';

  const turnEl = document.createElement('span');
  turnEl.className = 'card-turn';
  turnEl.textContent = `turn ${snapshot.turnNumber}`;

  meta.appendChild(taskEl);
  meta.appendChild(turnEl);
  hdr.appendChild(sessionEl);
  hdr.appendChild(meta);
  card.appendChild(hdr);

  // -- File sections --
  for (const ev of snapshot.events ?? []) {
    card.appendChild(buildFileSection(ev));
  }

  // -- Actions --
  const hasTask = !!snapshot.task;
  if (!hasTask) {
    const note = document.createElement('div');
    note.className = 'no-task-note';
    note.textContent = 'no task id — diff visible but approve/reject disabled';
    card.appendChild(note);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'btn-reject';
  rejectBtn.textContent = 'Reject';
  rejectBtn.disabled = !hasTask;

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn-approve';
  approveBtn.textContent = 'Approve';
  approveBtn.disabled = !hasTask;

  rejectBtn.addEventListener('click', () => submitDecision('reject', snapshot, digest));
  approveBtn.addEventListener('click', () => submitDecision('approve', snapshot, digest));

  actions.appendChild(rejectBtn);
  actions.appendChild(approveBtn);
  card.appendChild(actions);

  // -- Dismissed overlay (with Undo to revert an accidental decision) --
  const dismissed = document.createElement('div');
  dismissed.className = 'card-dismissed';
  const undoBtn = document.createElement('button');
  undoBtn.className = 'btn-undo';
  undoBtn.textContent = 'Undo';
  undoBtn.addEventListener('click', () => submitUndo(snapshot));
  dismissed.appendChild(undoBtn);
  card.appendChild(dismissed);

  wrap.appendChild(card);

  // -- Gesture hint labels --
  const hintL = document.createElement('div');
  hintL.className = 'gesture-hint left';
  hintL.textContent = 'REJECT';
  const hintR = document.createElement('div');
  hintR.className = 'gesture-hint right';
  hintR.textContent = 'APPROVE';
  wrap.appendChild(hintL);
  wrap.appendChild(hintR);

  return wrap;
}

function buildFileSection(ev) {
  const section = document.createElement('div');
  section.className = 'file-section';

  const header = document.createElement('div');
  header.className = 'file-header';
  header.addEventListener('click', () => section.classList.toggle('collapsed'));

  const badge = document.createElement('span');
  badge.className = 'file-badge ' + (ev.isNew ? 'badge-new' : 'badge-edit');
  badge.textContent = ev.isNew ? 'new' : ev.tool;

  const pathEl = document.createElement('span');
  pathEl.textContent = ev.path;

  const toggle = document.createElement('span');
  toggle.className = 'file-toggle';
  toggle.textContent = '▾';

  header.appendChild(badge);
  header.appendChild(pathEl);
  header.appendChild(toggle);
  section.appendChild(header);

  // Diff pre
  const diffWrap = document.createElement('div');
  diffWrap.className = 'file-diff';
  const pre = document.createElement('pre');
  pre.className = 'diff-pre';

  if (ev.unifiedDiff) {
    for (const raw of ev.unifiedDiff.split('\n')) {
      const span = document.createElement('span');
      span.className = 'diff-line' + classifyLine(raw);
      span.textContent = raw;
      pre.appendChild(span);
    }
  }

  diffWrap.appendChild(pre);
  section.appendChild(diffWrap);
  return section;
}

function classifyLine(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return ' meta';
  if (line.startsWith('+')) return ' add';
  if (line.startsWith('-')) return ' remove';
  if (line.startsWith('@@')) return ' hunk';
  return '';
}

// ──────────────────────────────────────────
// 6. Gesture controller (Pointer Events)
// ──────────────────────────────────────────

function attachGesture(wrap, entry) {
  const snapshot = entry.snapshot;
  const digest   = entry.digest;
  const hasTask  = !!snapshot.task;

  let startX = 0;
  let startT = 0;
  let curX   = 0;
  let active = false;

  wrap.addEventListener('pointerdown', (e) => {
    // Ignore taps on buttons or file headers
    if (e.target.closest('button, .file-header')) return;
    // Locked once decided — the first approve/reject wins; no re-swipe.
    if (entry.decided) return;
    active = true;
    startX = e.clientX;
    startT = performance.now();
    curX   = 0;
    wrap.setPointerCapture(e.pointerId);
    wrap.classList.remove('springing');
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!active) return;
    curX = e.clientX - startX;
    wrap.querySelector('.card').style.transform = `translateX(${curX}px)`;

    const ratio = curX / wrap.offsetWidth;
    const card  = wrap.querySelector('.card');

    if (ratio > 0.15) {
      card.className = 'card tinting-approve';
      wrap.className = wrap.className.replace(/hint-\w+/g, '') + ' hint-approve';
    } else if (ratio < -0.15) {
      card.className = 'card tinting-reject';
      wrap.className = wrap.className.replace(/hint-\w+/g, '') + ' hint-reject';
    } else {
      card.className = 'card';
      wrap.className = wrap.className.replace(/hint-\w+/g, '');
    }
  });

  const endGesture = (e) => {
    if (!active) return;
    active = false;

    const dt   = performance.now() - startT;
    const vel  = Math.abs(curX) / Math.max(dt, 1);
    const ratio = curX / wrap.offsetWidth;
    const card  = wrap.querySelector('.card');

    const committed = hasTask && (Math.abs(ratio) >= SWIPE_THRESHOLD || vel >= SWIPE_VELOCITY);

    if (committed) {
      const action = curX > 0 ? 'approve' : 'reject';
      submitDecision(action, snapshot, digest);
    }

    // Spring back
    card.style.transform = '';
    card.className = 'card';
    wrap.classList.remove('hint-approve', 'hint-reject');
    wrap.classList.add('springing');
    wrap.addEventListener('transitionend', () => wrap.classList.remove('springing'), { once: true });
  };

  wrap.addEventListener('pointerup',     endGesture);
  wrap.addEventListener('pointercancel', endGesture);
}

// ──────────────────────────────────────────
// 7. Approve / reject actions
// ──────────────────────────────────────────

async function submitDecision(action, snapshot, digest) {
  if (!token) return;
  if (!snapshot.task) return;

  // First decision wins. Lock the card BEFORE the request so a second swipe/click
  // (or the opposite action) can't fire while this one is in flight — otherwise an
  // approve and a reject could both reach the server. Reverted below if the request
  // fails, so the user can retry.
  const entry = cards.get(cardKey(snapshot));
  if (entry?.decided) return;
  if (entry) entry.decided = true;

  const url = action === 'approve' ? '/approve' : '/reject';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        sessionId: snapshot.sessionId,
        taskId:    snapshot.task,
        digest,
      }),
    });
  } catch {
    // Network failure — unlock so a reconnect/retry can resubmit.
    if (entry) entry.decided = false;
    return;
  }

  if (res.status === 401) {
    if (entry) entry.decided = false;
    showTokenError();
    return;
  }

  if (res.status === 409) {
    // Stale — drop card; server will re-push fresh turn via WS.
    if (entry) {
      entry.el.remove();
      cards.delete(cardKey(snapshot));
    }
    showEmptyIfNeeded();
    return;
  }

  if (!res.ok) {
    // Other errors: unlock so the card can be retried; it stays on screen.
    if (entry) entry.decided = false;
    console.warn(`[DiffViewer] ${action} failed: ${res.status}`);
    return;
  }

  // Success: visually mark via overlay (WS broadcast will also trigger markCard)
  markCard(snapshot.sessionId, action === 'approve' ? 'approved' : 'rejected');
}

// ──────────────────────────────────────────
// 8. UI helpers
// ──────────────────────────────────────────

function setBanner(state) {
  const banner = document.getElementById('banner');
  banner.className = state;
  banner.querySelector('.label').textContent =
    state === 'connecting'   ? 'Connecting…' :
    state === 'connected'    ? 'Connected'    :
    /* disconnected */         'Disconnected';
  updateTokenBadge();
}

function updateTokenBadge() {
  const badge = document.getElementById('token-badge');
  if (!badge) return;
  if (token) {
    badge.className = 'token-badge present';
    badge.textContent = 'token ✓';
  } else {
    badge.className = 'token-badge';
    badge.textContent = 'no token';
  }
}

function showTokenError() {
  clearToken();
  disconnect();
  const el = document.getElementById('token-error');
  if (el) { el.className = 'show'; el.style.display = 'block'; }
  showPairScreen();
}

function showPairScreen() {
  document.getElementById('pair-screen').style.display = '';
  document.getElementById('review-screen').style.display = 'none';
}

function showReviewScreen() {
  document.getElementById('pair-screen').style.display = 'none';
  document.getElementById('review-screen').style.display = '';
  showEmptyIfNeeded();
}

function showEmptyIfNeeded() {
  const stack = document.getElementById('review-screen');
  if (cards.size === 0 && !stack.querySelector('.card-wrap')) {
    let empty = document.getElementById('empty-state');
    if (!empty) {
      empty = document.createElement('div');
      empty.id = 'empty-state';
      empty.textContent = 'Waiting for agent turns…';
      stack.appendChild(empty);
    }
  }
}

// ──────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────

function boot() {
  token = loadToken();

  updateTokenBadge();

  if (token) {
    showReviewScreen();
    connect();
  } else {
    showPairScreen();
    setBanner('disconnected');
  }

  // Pair form submit
  document.getElementById('pair-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('token-input');
    const val = input.value.trim();
    if (!val) return;
    saveToken(val);
    document.getElementById('token-error').style.display = 'none';
    showReviewScreen();
    connect();
  });

  // Wake the WebSocket promptly when the PWA is foregrounded or the network
  // returns — iOS suspends the socket + backoff timer in the background, so a
  // timer-driven reconnect can lag badly. These events fire on resume.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectNow();
  });
  window.addEventListener('online', reconnectNow);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
