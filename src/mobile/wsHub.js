/**
 * wsHub.js — WebSocket hub for mobile companion (§6.1/§6.4)
 *
 * - First-frame token auth (5s timeout, 4KB cap, 4401 on bad frame)
 * - Caps: max 64 sockets total, max 8 unauthenticated, Origin-host==Host pre-upgrade
 * - push(snapshot): fan-out {type:'turn', snapshot, digest} to authed sockets
 * - Maintains per-session latest{digest,task,turnNumber}
 * - Bounded(20) last-snapshot replay buffer delivered on auth
 * - broadcast({type:'approved'|'rejected',...}) to all authed sockets
 * - repushSession(sessionId): re-sends latest snapshot for a session to all authed sockets
 */
import { WebSocketServer } from 'ws';
import { checkToken } from './auth.js';
import { computeDigest } from './approvals.js';

const MAX_SOCKETS = 64;
const MAX_UNAUTH = 8;
const AUTH_TIMEOUT_MS = 5000;
const FIRST_FRAME_MAX = 4 * 1024; // 4 KB
const REPLAY_BUFFER_MAX = 20;

export class WsHub {
  constructor({ token }) {
    this._token = token;
    // Set of authenticated WebSocket instances
    this._authed = new Set();
    // Set of all open (including pending-auth) sockets
    this._all = new Set();
    // Per-session latest: Map<sessionId, {digest, task, turnNumber, snapshot}>
    this._latest = new Map();
    // Replay buffer: array of {sessionId, snapshot, digest} (bounded 20)
    this._replayBuf = [];
    // Rejected set: Map<sessionId, {type:'rejected', taskId, sessionId}> (§6.3).
    // Replayed on auth so a reconnecting phone re-greys a rejected card.
    // In-memory only; lost on restart by design.
    this._rejected = new Map();

    this._wss = null; // set by attach()
  }

  /**
   * attach(server) — attach to an existing http.Server for WS upgrade handling.
   * Must be called once before any connections arrive.
   */
  attach(server) {
    const wss = new WebSocketServer({ noServer: true });
    this._wss = wss;

    server.on('upgrade', (req, socket, head) => {
      // URL path must be /ws
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      // Origin-host == Host pre-upgrade check (§6.4)
      const origin = req.headers['origin'];
      const host = req.headers['host'];
      if (process.env.DIFFVIEWER_MOBILE_DEBUG) {
        console.error(`[mobile-ws] upgrade /ws origin=${origin ?? '(none)'} host=${host ?? '(none)'}`);
      }
      if (origin) {
        try {
          const originHost = new URL(origin).host;
          const reqHost = host ?? '';
          if (originHost !== reqHost) {
            if (process.env.DIFFVIEWER_MOBILE_DEBUG) {
              console.error(`[mobile-ws] 403 Origin mismatch: originHost=${originHost} !== reqHost=${reqHost}`);
            }
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      // Cap: max 64 total sockets
      if (this._all.size >= MAX_SOCKETS) {
        socket.write('HTTP/1.1 503 Too Many Connections\r\n\r\n');
        socket.destroy();
        return;
      }

      // Cap: max 8 unauthenticated
      const unauthCount = this._all.size - this._authed.size;
      if (unauthCount >= MAX_UNAUTH) {
        socket.write('HTTP/1.1 503 Too Many Pending\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        this._all.add(ws);
        this._handleNewSocket(ws);
      });
    });
  }

  _handleNewSocket(ws) {
    let authenticated = false;

    // 5s auth timeout
    const timer = setTimeout(() => {
      if (!authenticated) {
        ws.close(4401, 'auth timeout');
        this._all.delete(ws);
      }
    }, AUTH_TIMEOUT_MS);

    ws.once('message', (data) => {
      clearTimeout(timer);

      // 4 KB first-frame cap
      const len = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
      if (len > FIRST_FRAME_MAX) {
        ws.close(4401, 'first frame too large');
        this._all.delete(ws);
        return;
      }

      // Parse auth frame
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        ws.close(4401, 'invalid json');
        this._all.delete(ws);
        return;
      }

      if (frame.type !== 'auth' || !checkToken(frame.token, this._token)) {
        if (process.env.DIFFVIEWER_MOBILE_DEBUG) {
          console.error(`[mobile-ws] 4401 bad auth: type=${frame.type} tokenLen=${frame.token ? String(frame.token).length : 0}`);
        }
        ws.close(4401, 'bad auth');
        this._all.delete(ws);
        return;
      }

      // Authenticated
      authenticated = true;
      this._authed.add(ws);
      if (process.env.DIFFVIEWER_MOBILE_DEBUG) {
        console.error('[mobile-ws] authed OK -> ready sent');
      }

      // Send ready
      this._send(ws, { type: 'ready' });

      // Replay buffer: send all buffered {snapshot, digest} pairs
      for (const entry of this._replayBuf) {
        this._send(ws, { type: 'turn', snapshot: entry.snapshot, digest: entry.digest });
      }

      // Replay rejected markers (§6.3) — sent AFTER turns so the card exists
      // client-side when the grey-out is applied.
      for (const msg of this._rejected.values()) {
        this._send(ws, msg);
      }

      ws.on('message', () => {
        // Post-auth messages from client are ignored in MVP-0
      });

      ws.on('close', () => {
        this._authed.delete(ws);
        this._all.delete(ws);
      });

      ws.on('error', () => {
        this._authed.delete(ws);
        this._all.delete(ws);
      });
    });

    ws.on('close', () => {
      clearTimeout(timer);
      this._authed.delete(ws);
      this._all.delete(ws);
    });

    ws.on('error', () => {
      clearTimeout(timer);
      this._authed.delete(ws);
      this._all.delete(ws);
    });
  }

  /**
   * push(snapshot) — called when broadcaster emits a new turn snapshot.
   * Computes digest, records latest, fans out to authed sockets, updates replay buffer.
   */
  push(snapshot) {
    const digest = computeDigest(snapshot);
    const { sessionId, turnNumber } = snapshot;
    const task = snapshot.task ?? null;

    // Record latest
    this._latest.set(sessionId, { digest, task, turnNumber, snapshot });

    // A new turn supersedes any prior rejection of this session's card (§6.3):
    // the fresh card must not arrive pre-greyed on a reconnect.
    this._rejected.delete(sessionId);

    // Update bounded replay buffer
    // Remove old entry for this session if present, then append
    const idx = this._replayBuf.findIndex(e => e.sessionId === sessionId);
    if (idx !== -1) this._replayBuf.splice(idx, 1);
    this._replayBuf.push({ sessionId, snapshot, digest });
    if (this._replayBuf.length > REPLAY_BUFFER_MAX) {
      this._replayBuf.shift(); // evict oldest
    }

    // Fan-out to all authed sockets
    const msg = { type: 'turn', snapshot, digest };
    for (const ws of [...this._authed]) {
      this._send(ws, msg);
    }
  }

  /**
   * broadcast(msg) — send an arbitrary message to all authed sockets.
   * Used for {type:'approved',...} and {type:'rejected',...}.
   */
  broadcast(msg) {
    for (const ws of [...this._authed]) {
      this._send(ws, msg);
    }
  }

  /**
   * reject(taskId, sessionId) — record the rejected card in the rejected set
   * (so reconnecting phones re-grey it, §6.3) and broadcast it live.
   */
  reject(taskId, sessionId) {
    const msg = { type: 'rejected', taskId, sessionId };
    this._rejected.set(sessionId, msg);
    this.broadcast(msg);
  }

  /**
   * undo(taskId, sessionId) — revert a decision: clear the rejected marker (so it
   * is not replayed on reconnect) and broadcast {type:'undo'} so every device
   * un-marks the card. Token deletion (approve revert) is handled by the caller.
   */
  undo(taskId, sessionId) {
    this._rejected.delete(sessionId);
    this.broadcast({ type: 'undo', taskId, sessionId });
  }

  /**
   * repushSession(sessionId) — re-send latest snapshot for sessionId to all authed sockets.
   * Called after 409 stale response so phone gets the fresh turn.
   */
  repushSession(sessionId) {
    const entry = this._latest.get(sessionId);
    if (!entry) return;
    const msg = { type: 'turn', snapshot: entry.snapshot, digest: entry.digest };
    for (const ws of [...this._authed]) {
      this._send(ws, msg);
    }
  }

  /**
   * getLatest(sessionId) — returns {digest, task, turnNumber} or undefined.
   */
  getLatest(sessionId) {
    const entry = this._latest.get(sessionId);
    if (!entry) return undefined;
    return { digest: entry.digest, task: entry.task, turnNumber: entry.turnNumber };
  }

  _send(ws, msg) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    } catch {
      this._authed.delete(ws);
      this._all.delete(ws);
    }
  }

  close() {
    if (this._wss) {
      this._wss.close();
    }
    for (const ws of [...this._all]) {
      try { ws.terminate(); } catch {}
    }
    this._all.clear();
    this._authed.clear();
  }
}
