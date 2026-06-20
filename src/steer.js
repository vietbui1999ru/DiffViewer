import { execFile } from 'node:child_process';

// default clipboard writer (macOS)
export function pbcopy(text) {
  return new Promise((resolve, reject) => {
    const p = execFile('pbcopy', (err) => (err ? reject(err) : resolve()));
    p.stdin.on('error', reject);
    p.stdin.write(text);
    p.stdin.end();
  });
}

export function makeClipboardSteerExec(copy = pbcopy) {
  return async ({ text }) => copy(text);
}

export function makeOpenCodeSteerExec({
  serverUrl,
  username = process.env.OPENCODE_SERVER_USERNAME || 'opencode',
  password = process.env.OPENCODE_SERVER_PASSWORD,
  fetchImpl = fetch,
} = {}) {
  if (!serverUrl) throw new Error('serverUrl required');
  const base = new URL(serverUrl);

  return async ({ sessionId, text }) => {
    const url = new URL(`/session/${encodeURIComponent(sessionId)}/prompt_async`, base);
    const headers = { 'content-type': 'application/json' };
    if (password) {
      headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    });
    if (!res.ok) throw new Error(`opencode steer failed: ${res.status}`);
  };
}

export function makeDefaultSteerExec(env = process.env) {
  if (env.OPENCODE_SERVER_URL) {
    const direct = makeOpenCodeSteerExec({
      serverUrl: env.OPENCODE_SERVER_URL,
      username: env.OPENCODE_SERVER_USERNAME || 'opencode',
      password: env.OPENCODE_SERVER_PASSWORD,
    });
    const clipboard = makeClipboardSteerExec();
    return async (payload) => payload.synthetic ? clipboard(payload) : direct(payload);
  }
  return makeClipboardSteerExec();
}

// returns a Hono handler; exec({ sessionId, text }) is injectable for tests
export function makeSteerHandler(exec = makeDefaultSteerExec()) {
  return async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid body' }, 400); }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : null;
    const text = typeof body.text === 'string' ? body.text.trim() : null;
    const synthetic = body.synthetic === true;
    if (!sessionId) return c.json({ error: 'sessionId required' }, 400);
    if (!text) return c.json({ error: 'text required' }, 400);
    try {
      const payload = { sessionId, text };
      if (synthetic) payload.synthetic = true;
      await exec(payload);
    } catch {
      return c.json({ error: 'exec failed' }, 500);
    }
    return c.body(null, 200);
  };
}
