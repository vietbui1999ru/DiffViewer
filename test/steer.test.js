import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/app.js';

function harness() {
  const exec = vi.fn(async () => {});
  const app = createApp({ steerExec: exec });
  const post = (body) =>
    app.request('/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { post, exec };
}

describe('POST /steer', () => {
  it('AC-ST1 valid text -> exec called, 200', async () => {
    const { post, exec } = harness();
    const r = await post({ sessionId: 's1', text: 'fix the import' });
    expect(r.status).toBe(200);
    expect(exec).toHaveBeenCalledWith('fix the import');
  });

  it('AC-ST2 empty text -> 400, exec not called', async () => {
    const { post, exec } = harness();
    const r = await post({ sessionId: 's1', text: '' });
    expect(r.status).toBe(400);
    expect(exec).not.toHaveBeenCalled();
  });

  it('AC-ST3 missing text -> 400', async () => {
    const { post } = harness();
    expect((await post({ sessionId: 's1' })).status).toBe(400);
  });

  it('AC-ST4 whitespace-only -> 400', async () => {
    const { post, exec } = harness();
    const r = await post({ sessionId: 's1', text: '   ' });
    expect(r.status).toBe(400);
    expect(exec).not.toHaveBeenCalled();
  });
});
