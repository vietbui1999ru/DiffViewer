import { serve } from '@hono/node-server';
import { createApp } from './src/app.js';

const app = createApp();
serve({ fetch: app.fetch, port: 3333 }, (info) =>
  console.log(`DiffViewer on http://localhost:${info.port}`)
);
