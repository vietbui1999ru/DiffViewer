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

// returns a Hono handler; exec(text) is injectable for tests
export function makeSteerHandler(exec = pbcopy) {
  return async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid body' }, 400); }
    const text = typeof body.text === 'string' ? body.text.trim() : null;
    if (!text) return c.json({ error: 'text required' }, 400);
    try {
      await exec(text);
    } catch {
      return c.json({ error: 'exec failed' }, 500);
    }
    return c.body(null, 200);
  };
}
