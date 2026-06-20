import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { makeClipboardSteerExec, makeOpenCodeSteerExec } from '../src/steer.js';

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
    expect(exec).toHaveBeenCalledWith({ sessionId: 's1', text: 'fix the import' });
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

  it('AC-ST3b missing sessionId -> 400', async () => {
    const { post, exec } = harness();
    expect((await post({ text: 'hello' })).status).toBe(400);
    expect(exec).not.toHaveBeenCalled();
  });

  it('AC-ST4 whitespace-only -> 400', async () => {
    const { post, exec } = harness();
    const r = await post({ sessionId: 's1', text: '   ' });
    expect(r.status).toBe(400);
    expect(exec).not.toHaveBeenCalled();
  });

  it('AC-ST5 exec throws -> 500', async () => {
    const exec = vi.fn(async () => { throw new Error('pbcopy failed'); });
    const app = createApp({ steerExec: exec });
    const r = await app.request('/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', text: 'hello' }),
    });
    expect(r.status).toBe(500);
  });

  it('AC-ST6 OpenCode exec posts prompt_async to the target session', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 }));
    const exec = makeOpenCodeSteerExec({
      serverUrl: 'http://127.0.0.1:4096',
      fetchImpl,
    });

    await exec({ sessionId: 'ses_abc123', text: 'continue this fix' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:4096/session/ses_abc123/prompt_async');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      parts: [{ type: 'text', text: 'continue this fix' }],
    });
  });

  it('AC-ST7 OpenCode exec supports basic auth', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 }));
    const exec = makeOpenCodeSteerExec({
      serverUrl: 'http://127.0.0.1:4096',
      username: 'u',
      password: 'p',
      fetchImpl,
    });

    await exec({ sessionId: 'ses_auth', text: 'hello' });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('AC-ST8 clipboard fallback copies only text', async () => {
    const copy = vi.fn(async () => {});
    const exec = makeClipboardSteerExec(copy);

    await exec({ sessionId: 'ignored', text: 'copy me' });

    expect(copy).toHaveBeenCalledWith('copy me');
  });

  it('AC-ST9 synthetic cards use clipboard even when OpenCode URL is configured', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 }));
    const copy = vi.fn(async () => {});
    const direct = makeOpenCodeSteerExec({ serverUrl: 'http://127.0.0.1:4096', fetchImpl });
    const clipboard = makeClipboardSteerExec(copy);
    const exec = async (payload) => payload.synthetic ? clipboard(payload) : direct(payload);

    await exec({ sessionId: 'demo-session', text: 'copy this', synthetic: true });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith('copy this');
  });
});
