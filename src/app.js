import { Hono } from 'hono';
import { SessionRegistry } from './turnBuffer.js';
import { Broadcaster } from './broadcaster.js';
import { normalizeEvent } from './normalizer.js';
import { makeSteerHandler } from './steer.js';

const KNOWN_TOOLS = new Set(['write', 'edit', 'multiedit']);

export function createApp(deps = {}) {
  const registry = deps.registry ?? new SessionRegistry();
  const broadcaster = deps.broadcaster ?? new Broadcaster();

  const app = new Hono();

  app.post('/event', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid body' }, 400); }
    const { sessionId, tool, path, oldContent, newContent } = body;
    if (typeof sessionId !== 'string' || !sessionId) return c.json({ error: 'sessionId required' }, 400);
    if (typeof path !== 'string' || !path) return c.json({ error: 'path required' }, 400);
    if (!KNOWN_TOOLS.has(String(tool).toLowerCase())) return c.body(null, 200);
    registry.add(sessionId, normalizeEvent({ tool, path, oldContent, newContent }));
    return c.body(null, 200);
  });

  app.post('/steer', makeSteerHandler(deps.steerExec));

  app.post('/turn-end', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid body' }, 400); }
    const { sessionId } = body;
    if (typeof sessionId !== 'string' || !sessionId) return c.json({ error: 'sessionId required' }, 400);
    const snapshot = registry.flush(sessionId);
    if (snapshot) broadcaster.emit(snapshot);
    return c.body(null, 200);
  });

  app.get('/', (c) => c.text('DiffViewer v0.5'));

  // exposed so server.js can share the same instances with /stream and /steer
  app._registry = registry;
  app._broadcaster = broadcaster;
  return app;
}
