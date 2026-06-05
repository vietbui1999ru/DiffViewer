import { describe, it, expect, afterEach } from 'vitest';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { SessionRegistry } from '../src/turnBuffer.js';

let server;
afterEach(() => server?.close());

describe('GET /stream', () => {
  it('AC-UI(wire) emits a turn-complete frame on turn-end', async () => {
    const registry = new SessionRegistry(() => 1);
    const app = createApp({ registry });
    server = serve({ fetch: app.fetch, port: 0 });
    const { port } = server.address();
    const base = `http://localhost:${port}`;

    // open SSE, read the first frame
    const res = await fetch(`${base}/stream`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();

    // drive a turn
    await fetch(`${base}/event`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', tool: 'Write', path: 'a.js', oldContent: '', newContent: 'hi\n' }),
    });
    await fetch(`${base}/turn-end`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    });

    let buf = '';
    while (!buf.includes('turn-complete')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    expect(buf).toContain('event: turn-complete');
    expect(buf).toContain('"path":"a.js"');
    await reader.cancel();
  }, 10000);
});
