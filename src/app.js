import { Hono } from 'hono';

export function createApp(_deps = {}) {
  const app = new Hono();
  app.get('/', (c) => c.text('DiffViewer v0.5'));
  return app;
}
