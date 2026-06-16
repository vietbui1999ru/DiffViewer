import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { execFile } from 'node:child_process';
import { createApp } from './src/app.js';
import { createSidecarWatcher } from './src/sidecarWatcher.js';
import { makeDefaultAnnotateExec } from './src/annotate.js';

// Watch roots: CLI args (non-flag) or DIFFVIEWER_WATCH_ROOTS (colon-separated)
const args = process.argv.slice(2);
const mobileFlag = args.includes('--mobile') || process.env.DIFFVIEWER_MOBILE === '1';
const pairFlag = args.includes('--pair');
const roots = args.filter(a => !a.startsWith('--')).filter(Boolean);

if (roots.length === 0 && process.env.DIFFVIEWER_WATCH_ROOTS) {
  roots.push(...process.env.DIFFVIEWER_WATCH_ROOTS.split(':').filter(Boolean));
}

const app = createApp({
  annotateExec: makeDefaultAnnotateExec({ roots }),
  architectureRoot: roots[0] ?? process.cwd(),
  rootPlaceholder: false,
});

// serve browser/ assets; GET / -> browser/index.html
app.use('/*', serveStatic({ root: './browser' }));

// Open-once-then-notify: best-effort, never a gate. Uses the macOS built-in `open`
// and `osascript` (no npm deps — `open`/`node-notifier` are not in package.json).
// Errors are swallowed so a missing binary or non-macOS host degrades to a no-op.
const onFirstTurn = () => {
  execFile('open', ['http://localhost:3333'], () => {});
};
const onSubsequentTurn = (sessionId) => {
  execFile('osascript', ['-e', `display notification "New turn for ${sessionId}" with title "DiffViewer"`], () => {});
};

if (roots.length > 0) {
  createSidecarWatcher(roots, {
    registry: app._registry,
    broadcaster: app._broadcaster,
    onFirstTurn,
    onSubsequentTurn,
  });
}

serve({ fetch: app.fetch, port: 3333, hostname: '127.0.0.1' }, (info) => {
  console.log(`DiffViewer on http://localhost:${info.port}`);
  if (roots.length > 0) {
    console.log(`Watching sidecar roots: ${roots.join(', ')}`);
  }
});

// ---- Mobile companion (--mobile or DIFFVIEWER_MOBILE === '1') ----
if (mobileFlag) {
  // Lazy imports to keep startup fast when mobile is off
  const { loadOrCreateToken } = await import('./src/mobile/auth.js');
  const { createMobileServer } = await import('./src/mobile/index.js');
  // qrcode-terminal is a CommonJS package
  const { default: qrcode } = await import('qrcode-terminal');

  const token = await loadOrCreateToken();

  const { server: mobileServer } = await createMobileServer({
    broadcaster: app._broadcaster,
    roots,
    options: {
      token,
      port: 3334,
      hostname: '127.0.0.1',
    },
  });

  const mobilePort = mobileServer.address().port;
  console.log(`DiffViewer Mobile on http://localhost:${mobilePort}`);

  if (pairFlag) {
    const mobileUrl = process.env.DIFFVIEWER_MOBILE_URL;
    // --pair is the REMOTE pairing path (a phone over Tailscale). Same-machine
    // access just opens http://localhost:3334 directly, so refuse to emit an
    // unreachable localhost QR — require an https tailnet URL and fail loud.
    if (!mobileUrl || !mobileUrl.startsWith('https://')) {
      console.error(
        '\nERROR: --pair requires DIFFVIEWER_MOBILE_URL set to your https tailnet URL.\n' +
        'A localhost QR cannot be reached from a phone. To pair a remote phone:\n\n' +
        '  1. Expose the mobile listener over your tailnet (Tailscale 1.60+ syntax):\n' +
        '       tailscale serve --bg 3334\n' +
        '  2. Re-run with your MagicDNS host (shown by `tailscale status`):\n' +
        '       DIFFVIEWER_MOBILE_URL=https://<your-host>.ts.net node server.js --mobile --pair\n\n' +
        'Revoke by deleting ~/.diffviewer/mobile/token and restarting.'
      );
      process.exit(1);
    }
    const pairingUrl = `${mobileUrl}/#token=${token}`;
    console.log(`\nPairing URL: ${pairingUrl}`);
    console.log('Scan the QR to open the PWA with the token pre-loaded:\n');
    qrcode.generate(pairingUrl, { small: true });
    console.log(
      '\nServe it over your tailnet if you have not already (Tailscale 1.60+ syntax):\n' +
      '  tailscale serve --bg 3334\n' +
      'Revoke by deleting ~/.diffviewer/mobile/token and restarting.'
    );
  }
}
