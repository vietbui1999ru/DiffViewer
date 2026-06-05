import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { SessionRegistry } from '../src/turnBuffer.js';

function harness() {
  const registry = new SessionRegistry(() => 1);
  const emitted = [];
  const broadcaster = { emit: (s) => emitted.push(s) };
  const app = createApp({ registry, broadcaster });
  const post = (path, body) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, post, emitted };
}

describe('POST /event + /turn-end', () => {
  it('AC-E1/E3 write event buffered, turn-end emits snapshot', async () => {
    const { post, emitted } = harness();
    const r1 = await post('/event', { sessionId: 's1', tool: 'Write', path: 'a.js', oldContent: '', newContent: 'hi\n' });
    expect(r1.status).toBe(200);
    const r2 = await post('/turn-end', { sessionId: 's1' });
    expect(r2.status).toBe(200);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].events.map(e => e.path)).toEqual(['a.js']);
    expect(emitted[0].events[0].isNew).toBe(true);
  });

  it('AC-E2 unknown tool is dropped', async () => {
    const { post, emitted } = harness();
    const r = await post('/event', { sessionId: 's1', tool: 'Bash', path: 'x', oldContent: '', newContent: '' });
    expect(r.status).toBe(200);
    await post('/turn-end', { sessionId: 's1' });
    expect(emitted).toHaveLength(0);
  });

  it('AC-E4 empty turn does not emit', async () => {
    const { post, emitted } = harness();
    const r = await post('/turn-end', { sessionId: 's1' });
    expect(r.status).toBe(200);
    expect(emitted).toHaveLength(0);
  });

  it('AC-E5 sessions stay isolated', async () => {
    const { post, emitted } = harness();
    await post('/event', { sessionId: 's1', tool: 'Edit', path: 'a', oldContent: 'x', newContent: 'y' });
    await post('/event', { sessionId: 's2', tool: 'Edit', path: 'b', oldContent: 'x', newContent: 'y' });
    await post('/turn-end', { sessionId: 's2' });
    expect(emitted[0].events.map(e => e.path)).toEqual(['b']);
    // s1's buffer must still be intact
    await post('/turn-end', { sessionId: 's1' });
    expect(emitted[1].events.map(e => e.path)).toEqual(['a']);
  });
});
