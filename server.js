import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './src/app.js';

const app = createApp();

// serve browser/ assets; GET / -> browser/index.html
app.use('/*', serveStatic({ root: './browser' }));

serve({ fetch: app.fetch, port: 3333, hostname: '127.0.0.1' }, (info) =>
  console.log(`DiffViewer on http://localhost:${info.port}`)
);
