import { Hono } from 'hono';
import { SessionRegistry } from './turnBuffer.js';
import { Broadcaster } from './broadcaster.js';
import { normalizeEvent } from './normalizer.js';

const KNOWN_TOOLS = new Set(['write', 'edit', 'multiedit']);

export function createApp(deps = {}) {
  const registry = deps.registry ?? new SessionRegistry();
  const broadcaster = deps.broadcaster ?? new Broadcaster();

  const app = new Hono();

  app.post('/event', async (c) => {
    const { sessionId, tool, path, oldContent, newContent } = await c.req.json();
    if (!KNOWN_TOOLS.has(String(tool).toLowerCase())) return c.body(null, 200);
    registry.add(sessionId, normalizeEvent({ tool, path, oldContent, newContent }));
    return c.body(null, 200);
  });

  app.post('/turn-end', async (c) => {
    const { sessionId } = await c.req.json();
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
