/**
 * mobile.api.test.js
 *
 * REST endpoint tests: auth, body cap, malformed body, null-task.
 * §9: every endpoint without/with wrong token → 401; malformed body → 400;
 *     > 16 KB body → 413; null-task snapshot approve → 400.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMobileServer } from '../src/mobile/index.js';
import { Broadcaster } from '../src/broadcaster.js';

const TOKEN = 'test-api-token-32byteslong-xxxxxx';
const WRONG_TOKEN = 'wrong-token-not-the-right-one-000';

let servers = [];
let tmpDirs = [];

afterEach(async () => {
  for (const s of servers) {
    try { await s.close(); } catch {}
  }
  servers = [];
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  tmpDirs = [];
});

async function startServer(broadcaster, roots = []) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-api-test-'));
  tmpDirs.push(homeDir);
  const { server, close } = await createMobileServer({
    broadcaster,
    roots,
    options: { token: TOKEN, port: 0, hostname: '127.0.0.1', homeDir },
  });
  servers.push({ close });
  const port = server.address().port;
  return { port, homeDir };
}

function makeTmpRoot(taskId = 'TASK-001') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-api-root-'));
  tmpDirs.push(root);
  const claimedDir = path.join(root, '.agents', 'claimed');
  fs.mkdirSync(claimedDir, { recursive: true });
  const taskFile = path.join(claimedDir, `host_1_${taskId}.md`);
  fs.writeFileSync(taskFile, `---\nid: ${taskId}\n---\n`);
  return root;
}

// Shared snapshot state helper: seeds hub.latest so approve works
async function seedLatest(port, broadcaster, sessionId, taskId) {
  // Push a snapshot through broadcaster; hub records latest
  const snap = {
    sessionId,
    turnNumber: 1,
    task: taskId,
    events: [{ tool: 'write', path: 'x.js', unifiedDiff: '+x\n' }],
    startedAt: Date.now(),
    completedAt: Date.now(),
  };
  broadcaster.emit(snap);
  // Allow hub to process
  await new Promise(r => setTimeout(r, 50));
}

describe('mobile API auth', () => {
  it('API-1: /approve without Authorization → 401', async () => {
    const broadcaster = new Broadcaster();
    const { port } = await startServer(broadcaster);

    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'x', digest: 'y', taskId: 'T' }),
    });
    expect(res.status).toBe(401);
  });

  it('API-2: /approve with wrong token → 401', async () => {
    const broadcaster = new Broadcaster();
    const { port } = await startServer(broadcaster);

    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WRONG_TOKEN}` },
      body: JSON.stringify({ sessionId: 'x', digest: 'y', taskId: 'T' }),
    });
    expect(res.status).toBe(401);
  });

  it('API-3: /reject without Authorization → 401', async () => {
    const broadcaster = new Broadcaster();
    const { port } = await startServer(broadcaster);

    const res = await fetch(`http://127.0.0.1:${port}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'x', digest: 'y', taskId: 'T' }),
    });
    expect(res.status).toBe(401);
  });

  it('API-4: /reject with wrong token → 401', async () => {
    const broadcaster = new Broadcaster();
    const { port } = await startServer(broadcaster);

    const res = await fetch(`http://127.0.0.1:${port}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WRONG_TOKEN}` },
      body: JSON.stringify({ sessionId: 'x', digest: 'y', taskId: 'T' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('mobile API body cap', () => {
  it('API-5: /approve with body > 16 KB → 413', async () => {
    const broadcaster = new Broadcaster();
    const { port } = await startServer(broadcaster);

    // 17 KB body
    const bigBody = JSON.stringify({ sessionId: 'x', digest: 'y', taskId: 'T', padding: 'x'.repeat(17 * 1024) });
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: bigBody,
    });
    expect(res.status).toBe(413);
  });

  it('API-6: /reject with body > 16 KB → 413', async () => {
    const broadcaster = new Broadcaster();
    const { port } = await startServer(broadcaster);

    const bigBody = JSON.stringify({ sessionId: 'x', digest: 'y', taskId: 'T', padding: 'x'.repeat(17 * 1024) });
    const res = await fetch(`http://127.0.0.1:${port}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WRONG_TOKEN}` },
      body: bigBody,
    });
    // Auth check can happen before body parse, so either 401 or 413 is acceptable
    // But with correct token:
    const res2 = await fetch(`http://127.0.0.1:${port}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: bigBody,
    });
    expect(res2.status).toBe(413);
  });
});

describe('mobile API malformed body', () => {
  it('API-7: /approve with non-JSON body → 400', async () => {
    const broadcaster = new Broadcaster();
    const { port } = await startServer(broadcaster);

    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: 'this is not json',
    });
    expect(res.status).toBe(400);
  });

  it('API-8: /reject with non-JSON body → 400', async () => {
    const broadcaster = new Broadcaster();
    const { port } = await startServer(broadcaster);

    const res = await fetch(`http://127.0.0.1:${port}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
  });
});

describe('mobile API null-task approve', () => {
  it('API-9: approve when snapshot has task=null → 400 task-mismatch', async () => {
    const broadcaster = new Broadcaster();
    const { port } = await startServer(broadcaster);

    // Seed a null-task snapshot
    const snap = {
      sessionId: 'null-task-sess',
      turnNumber: 1,
      task: null,
      events: [],
      startedAt: Date.now(),
      completedAt: Date.now(),
    };
    broadcaster.emit(snap);
    await new Promise(r => setTimeout(r, 50));

    // Compute the digest manually for this snapshot
    const { computeDigest } = await import('../src/mobile/approvals.js');
    const digest = computeDigest(snap);

    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: 'null-task-sess', digest, taskId: 'TASK-X' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('task-mismatch');
  });

  it('API-10: approve with valid token but missing sessionId fields → 400', async () => {
    const broadcaster = new Broadcaster();
    const { port } = await startServer(broadcaster);

    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({}),
    });
    // No sessionId/digest/taskId → should be some client error
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
