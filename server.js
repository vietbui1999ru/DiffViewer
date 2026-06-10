import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './src/app.js';
import { createSidecarWatcher } from './src/sidecarWatcher.js';

const app = createApp();

// serve browser/ assets; GET / -> browser/index.html
app.use('/*', serveStatic({ root: './browser' }));

// Watch roots: CLI args or DIFFVIEWER_WATCH_ROOTS (colon-separated)
const roots = process.argv.slice(2).filter(Boolean);
if (roots.length === 0 && process.env.DIFFVIEWER_WATCH_ROOTS) {
  roots.push(...process.env.DIFFVIEWER_WATCH_ROOTS.split(':').filter(Boolean));
}
if (roots.length > 0) {
  createSidecarWatcher(roots, {
    registry: app._registry,
    broadcaster: app._broadcaster,
  });
}

serve({ fetch: app.fetch, port: 3333, hostname: '127.0.0.1' }, (info) => {
  console.log(`DiffViewer on http://localhost:${info.port}`);
  if (roots.length > 0) {
    console.log(`Watching sidecar roots: ${roots.join(', ')}`);
  }
});
