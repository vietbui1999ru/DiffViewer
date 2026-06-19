/**
 * index.js — createMobileServer({broadcaster, roots, options}) → {server, close()}
 *
 * Routes:
 *   POST /approve  — digest-guarded approval (§6.2)
 *   POST /reject   — reject writes nothing (§6.3)
 *   GET  /ws       — WebSocket upgrade (handled by wsHub)
 *   GET  /*        — static browser-mobile/ assets (§8)
 *
 * Auth: Bearer token on REST (§4); first-frame token on WS (§6.4).
 * Body cap: 16 KB max on JSON endpoints → 413 (§3).
 */
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { checkToken } from './auth.js';
import {
  validateTaskId,
  resolveTask,
  writeApprovalToken,
  deleteApprovalToken,
} from './approvals.js';
import { WsHub } from './wsHub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_MOBILE_DIR = path.resolve(__dirname, '../../browser-mobile');

const BODY_CAP = 16 * 1024; // 16 KB

/**
 * Read the raw body from a Hono request, enforcing a byte cap.
 * Returns { ok: true, text } or { ok: false, status: 413 }.
 */
async function readBodyCapped(c, cap) {
  const raw = await c.req.raw.arrayBuffer().catch(() => null);
  if (raw === null) return { ok: false, status: 400 };
  if (raw.byteLength > cap) return { ok: false, status: 413 };
  return { ok: true, text: Buffer.from(raw).toString('utf8') };
}

/**
 * createMobileServer({broadcaster, roots, options}) → Promise<{server, close}>
 *
 * options:
 *   token    — shared auth token (required)
 *   port     — listen port (default 3334)
 *   hostname — bind hostname (default '127.0.0.1')
 */
export async function createMobileServer({ broadcaster, roots, options = {} }) {
  const token = options.token;
  if (!token) throw new Error('createMobileServer: options.token is required');

  const hub = new WsHub({ token });

  // Subscribe hub to the shared broadcaster
  const hubClient = {
    send: (snapshot) => hub.push(snapshot),
  };
  broadcaster.subscribe(hubClient);

  const app = new Hono();

  // ---- Bearer token check helper ----
  function extractBearer(c) {
    const authHeader = c.req.header('Authorization') ?? '';
    return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  }

  // ---- POST /approve ----
  app.post('/approve', async (c) => {
    // Auth first
    if (!checkToken(extractBearer(c), token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Body cap
    const rawResult = await readBodyCapped(c, BODY_CAP);
    if (!rawResult.ok) return c.json({ error: rawResult.status === 413 ? 'payload too large' : 'read error' }, rawResult.status);

    let body;
    try {
      body = JSON.parse(rawResult.text);
    } catch {
      return c.json({ error: 'invalid body' }, 400);
    }

    return handleApprove(c, body, hub, roots);
  });

  // ---- POST /reject ----
  app.post('/reject', async (c) => {
    // Auth first
    if (!checkToken(extractBearer(c), token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Body cap
    const rawResult = await readBodyCapped(c, BODY_CAP);
    if (!rawResult.ok) return c.json({ error: rawResult.status === 413 ? 'payload too large' : 'read error' }, rawResult.status);

    let body;
    try {
      body = JSON.parse(rawResult.text);
    } catch {
      return c.json({ error: 'invalid body' }, 400);
    }

    return handleReject(c, body, hub, roots);
  });

  // ---- POST /undo ----
  app.post('/undo', async (c) => {
    // Auth first
    if (!checkToken(extractBearer(c), token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Body cap
    const rawResult = await readBodyCapped(c, BODY_CAP);
    if (!rawResult.ok) return c.json({ error: rawResult.status === 413 ? 'payload too large' : 'read error' }, rawResult.status);

    let body;
    try {
      body = JSON.parse(rawResult.text);
    } catch {
      return c.json({ error: 'invalid body' }, 400);
    }

    return handleUndo(c, body, hub, roots);
  });

  // ---- Static browser-mobile/ ----
  if (fs.existsSync(BROWSER_MOBILE_DIR)) {
    // Serve relative to the project root (CWD), not the module dir
    const relPath = path.relative(process.cwd(), BROWSER_MOBILE_DIR);
    // Never cache the PWA shell: there is no service worker or build-time asset
    // hashing yet, and iOS Safari otherwise serves stale JS indefinitely — so a
    // client fix "deploys" but never reaches the device. no-store keeps the
    // device on the latest assets.
    app.use('/*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      await next();
    });
    app.use('/*', serveStatic({ root: relPath }));
  }

  app.get('/', (c) => c.text('DiffViewer Mobile v0.5'));

  // Build the HTTP server
  const port = options.port ?? 3334;
  const hostname = options.hostname ?? '127.0.0.1';

  const httpServer = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname }, () => resolve(s));
  });

  // Attach WebSocket hub to the raw node server
  hub.attach(httpServer);

  return {
    server: httpServer,
    close: () =>
      new Promise((resolve) => {
        hub.close();
        broadcaster.unsubscribe(hubClient);
        httpServer.close(() => resolve());
      }),
  };
}

// ---- Approve handler (extracted for readability) ----
async function handleApprove(c, body, hub, roots) {
  const { sessionId, digest, taskId } = body ?? {};

  if (typeof sessionId !== 'string' || !sessionId) return c.json({ error: 'sessionId required' }, 400);
  if (typeof digest !== 'string' || !digest) return c.json({ error: 'digest required' }, 400);
  if (typeof taskId !== 'string' || !taskId) return c.json({ error: 'taskId required' }, 400);

  // Step 2: digest guard
  const latest = hub.getLatest(sessionId);
  if (!latest || latest.digest !== digest) {
    hub.repushSession(sessionId);
    return c.json({
      error: 'stale',
      latest: latest ? { digest: latest.digest, turnNumber: latest.turnNumber } : null,
    }, 409);
  }

  // Step 3: task non-null and equals taskId
  if (latest.task === null || latest.task !== taskId) {
    return c.json({ error: 'task-mismatch' }, 400);
  }

  // Step 4: validateTaskId
  if (!validateTaskId(taskId)) {
    return c.json({ error: 'invalid-task-id' }, 400);
  }

  // Step 5: resolve task
  const resolved = resolveTask(roots, taskId);
  if (resolved.error === 'task-not-claimed') return c.json({ error: 'task-not-claimed' }, 404);
  if (resolved.error === 'ambiguous-task') return c.json({ error: 'ambiguous-task' }, 409);

  // Step 6: hardened write
  let result;
  try {
    result = writeApprovalToken(resolved.root, taskId, { digest, sessionId });
  } catch (err) {
    return c.json({ error: 'write-failed', message: err.message }, 500);
  }

  if (result.already) return c.json({ approved: true, already: true });

  // Step 7: broadcast
  hub.broadcast({ type: 'approved', taskId, sessionId });
  return c.json({ approved: true });
}

// ---- Reject handler ----
async function handleReject(c, body, hub, roots) {
  const { sessionId, digest, taskId } = body ?? {};

  if (typeof sessionId !== 'string' || !sessionId) return c.json({ error: 'sessionId required' }, 400);
  if (typeof digest !== 'string' || !digest) return c.json({ error: 'digest required' }, 400);
  if (typeof taskId !== 'string' || !taskId) return c.json({ error: 'taskId required' }, 400);

  // Step 2: digest guard
  const latest = hub.getLatest(sessionId);
  if (!latest || latest.digest !== digest) {
    hub.repushSession(sessionId);
    return c.json({
      error: 'stale',
      latest: latest ? { digest: latest.digest, turnNumber: latest.turnNumber } : null,
    }, 409);
  }

  // Step 3: task non-null and equals taskId
  if (latest.task === null || latest.task !== taskId) {
    return c.json({ error: 'task-mismatch' }, 400);
  }

  // Step 4: validateTaskId
  if (!validateTaskId(taskId)) {
    return c.json({ error: 'invalid-task-id' }, 400);
  }

  // Step 5: resolve task (same validation as approve — must be claimed)
  const resolved = resolveTask(roots, taskId);
  if (resolved.error === 'task-not-claimed') return c.json({ error: 'task-not-claimed' }, 404);
  if (resolved.error === 'ambiguous-task') return c.json({ error: 'ambiguous-task' }, 409);

  // Writes NOTHING to .agents/ (APPROVAL-1 denial clause).
  // hub.reject records the card in the rejected set so a reconnecting
  // phone re-greys it (§6.3), then broadcasts live.
  hub.reject(taskId, sessionId);
  return c.json({ rejected: true });
}

// ---- Undo handler ----
async function handleUndo(c, body, hub, roots) {
  const { sessionId, taskId } = body ?? {};

  if (typeof sessionId !== 'string' || !sessionId) {
    return c.json({ error: 'sessionId required' }, 400);
  }
  if (typeof taskId !== 'string' || !taskId) {
    return c.json({ error: 'taskId required' }, 400);
  }
  // No digest guard: undo reverts the task's decision regardless of which turn is
  // current — the point is to recover from an accidental approve/reject.
  if (!validateTaskId(taskId)) {
    return c.json({ error: 'invalid-task-id' }, 400);
  }

  const resolved = resolveTask(roots, taskId);
  if (resolved.error === 'task-not-claimed') return c.json({ error: 'task-not-claimed' }, 404);
  if (resolved.error === 'ambiguous-task') return c.json({ error: 'ambiguous-task' }, 409);

  // Revert an accidental approve (delete the bus token) and clear any rejected
  // marker, then broadcast {type:'undo'} so every device un-marks the card.
  let result;
  try {
    result = deleteApprovalToken(resolved.root, taskId);
  } catch (err) {
    return c.json({ error: 'undo-failed', message: err.message }, 500);
  }
  hub.undo(taskId, sessionId);
  return c.json({ undone: true, tokenDeleted: !!result.deleted });
}
