/**
 * mobile.ws.integration.test.js
 *
 * Full integration tests for wsHub + mobile server over real sockets.
 * §9: full loop, auth, replay, approve/reject, stale digest, Origin check.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createMobileServer } from '../src/mobile/index.js';
import { Broadcaster } from '../src/broadcaster.js';

const TOKEN = 'test-integration-token-32byteslong000';

// Build a minimal snapshot for pushing through broadcaster
function makeSnapshot(sessionId, turnNumber, task = 'TASK-001') {
  return {
    sessionId,
    turnNumber,
    task,
    events: [{ tool: 'write', path: 'src/foo.js', unifiedDiff: '@@ -0,0 +1 @@\n+hi\n' }],
    startedAt: Date.now() - 100,
    completedAt: Date.now(),
  };
}

// Create a tmp root with .agents structure
function makeTmpRoot(taskId = 'TASK-001') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-ws-test-'));
  const claimedDir = path.join(root, '.agents', 'claimed');
  fs.mkdirSync(claimedDir, { recursive: true });
  // Write a claimed task file
  const taskFile = path.join(claimedDir, `host_123_${taskId}.md`);
  fs.writeFileSync(taskFile, `---\nid: ${taskId}\n---\n## Context\n`);
  return root;
}

// Connect WS, authenticate, return ws + collected messages
async function connectAndAuth(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}/ws`);
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      // Wait a tick for ready response
      setTimeout(() => resolve({ ws, messages }), 100);
    });
  });
}

// Wait for condition with timeout
function waitFor(fn, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      try {
        const r = fn();
        if (r) { resolve(r); return; }
      } catch {}
      if (Date.now() - start > timeout) { reject(new Error(`waitFor timed out`)); return; }
      setTimeout(check, 30);
    };
    check();
  });
}

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

describe('mobile WS integration', () => {
  it('WS-1: auth frame → ready, then turn snapshot pushed → received', { timeout: 8000 }, async () => {
    const root = makeTmpRoot('TASK-001');
    tmpDirs.push(root);
    const broadcaster = new Broadcaster();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-home-'));
    tmpDirs.push(homeDir);

    const { server, close } = await createMobileServer({
      broadcaster,
      roots: [root],
      options: { token: TOKEN, port: 0, hostname: '127.0.0.1', homeDir },
    });
    servers.push({ close });

    const port = server.address().port;
    const url = `ws://127.0.0.1:${port}`;

    const { ws, messages } = await connectAndAuth(url, TOKEN);

    await waitFor(() => messages.find(m => m.type === 'ready'));
    expect(messages.some(m => m.type === 'ready')).toBe(true);

    // Push a snapshot via broadcaster
    const snap = makeSnapshot('sess-1', 1, 'TASK-001');
    broadcaster.emit(snap);

    await waitFor(() => messages.find(m => m.type === 'turn'), 4000);
    const turnMsg = messages.find(m => m.type === 'turn');
    expect(turnMsg).toBeDefined();
    expect(turnMsg.snapshot.sessionId).toBe('sess-1');
    expect(typeof turnMsg.digest).toBe('string');
    expect(turnMsg.digest).toHaveLength(64); // sha256 hex

    ws.close();
  });

  it('WS-2: approve with correct digest → 200 + token file', { timeout: 8000 }, async () => {
    const root = makeTmpRoot('TASK-002');
    tmpDirs.push(root);
    const broadcaster = new Broadcaster();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-home-'));
    tmpDirs.push(homeDir);

    const { server, close } = await createMobileServer({
      broadcaster,
      roots: [root],
      options: { token: TOKEN, port: 0, hostname: '127.0.0.1', homeDir },
    });
    servers.push({ close });
    const port = server.address().port;

    const { ws, messages } = await connectAndAuth(`ws://127.0.0.1:${port}`, TOKEN);
    await waitFor(() => messages.find(m => m.type === 'ready'));

    const snap = makeSnapshot('sess-approve', 1, 'TASK-002');
    broadcaster.emit(snap);
    await waitFor(() => messages.find(m => m.type === 'turn'));
    const { digest } = messages.find(m => m.type === 'turn');

    // POST approve
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: 'sess-approve', digest, taskId: 'TASK-002' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approved).toBe(true);

    // Approval token file exists
    const tokenFile = path.join(root, '.agents', 'approvals', 'TASK-002.approved');
    expect(fs.existsSync(tokenFile)).toBe(true);

    ws.close();
  });

  it('WS-3: stale digest → 409 + fresh turn re-pushed', { timeout: 8000 }, async () => {
    const root = makeTmpRoot('TASK-003');
    tmpDirs.push(root);
    const broadcaster = new Broadcaster();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-home-'));
    tmpDirs.push(homeDir);

    const { server, close } = await createMobileServer({
      broadcaster,
      roots: [root],
      options: { token: TOKEN, port: 0, hostname: '127.0.0.1', homeDir },
    });
    servers.push({ close });
    const port = server.address().port;

    const { ws, messages } = await connectAndAuth(`ws://127.0.0.1:${port}`, TOKEN);
    await waitFor(() => messages.find(m => m.type === 'ready'));

    // Turn 1
    broadcaster.emit(makeSnapshot('sess-stale', 1, 'TASK-003'));
    await waitFor(() => messages.find(m => m.type === 'turn' && m.snapshot.turnNumber === 1));
    const { digest: digest1 } = messages.find(m => m.type === 'turn' && m.snapshot.turnNumber === 1);

    // Turn 2 — makes digest1 stale
    broadcaster.emit(makeSnapshot('sess-stale', 2, 'TASK-003'));
    await waitFor(() => messages.filter(m => m.type === 'turn').length >= 2);

    // Approve with stale digest1
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: 'sess-stale', digest: digest1, taskId: 'TASK-003' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('stale');
    expect(body.latest.turnNumber).toBe(2);

    // Server re-pushes latest turn over WS after 409
    await waitFor(() => messages.filter(m => m.type === 'turn' && m.snapshot.sessionId === 'sess-stale').length >= 3, 4000);

    ws.close();
  });

  it('WS-4: reject writes nothing to .agents/', { timeout: 8000 }, async () => {
    const root = makeTmpRoot('TASK-004');
    tmpDirs.push(root);
    const broadcaster = new Broadcaster();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-home-'));
    tmpDirs.push(homeDir);

    const { server, close } = await createMobileServer({
      broadcaster,
      roots: [root],
      options: { token: TOKEN, port: 0, hostname: '127.0.0.1', homeDir },
    });
    servers.push({ close });
    const port = server.address().port;

    const { ws, messages } = await connectAndAuth(`ws://127.0.0.1:${port}`, TOKEN);
    await waitFor(() => messages.find(m => m.type === 'ready'));

    broadcaster.emit(makeSnapshot('sess-reject', 1, 'TASK-004'));
    await waitFor(() => messages.find(m => m.type === 'turn'));
    const { digest } = messages.find(m => m.type === 'turn');

    // Capture .agents/ listing before reject
    const agentsBefore = fs.readdirSync(path.join(root, '.agents'), { recursive: true }).sort();

    const res = await fetch(`http://127.0.0.1:${port}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: 'sess-reject', digest, taskId: 'TASK-004' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rejected).toBe(true);

    // .agents/ tree unchanged
    const agentsAfter = fs.readdirSync(path.join(root, '.agents'), { recursive: true }).sort();
    expect(agentsAfter).toEqual(agentsBefore);

    ws.close();
  });

  it('WS-5: unauthenticated socket receives nothing and is closed', { timeout: 8000 }, async () => {
    const broadcaster = new Broadcaster();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-home-'));
    tmpDirs.push(homeDir);

    const { server, close } = await createMobileServer({
      broadcaster,
      roots: [],
      options: { token: TOKEN, port: 0, hostname: '127.0.0.1', homeDir },
    });
    servers.push({ close });
    const port = server.address().port;

    // Connect but never send auth
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs = [];
    ws.on('message', d => msgs.push(d));

    // Push a snapshot — unauthed socket should get nothing
    await new Promise(r => ws.on('open', r));
    broadcaster.emit(makeSnapshot('sess-unauth', 1, 'TASK-X'));

    await new Promise(r => setTimeout(r, 200));
    expect(msgs).toHaveLength(0);

    // Socket should be closed after 5s timeout — verify by waiting for close event
    // (We use fake timers in the unit test; here we just verify no messages leaked)
    ws.close();
  });

  it('WS-6: oversized first frame → socket closed 4401', { timeout: 8000 }, async () => {
    const broadcaster = new Broadcaster();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-home-'));
    tmpDirs.push(homeDir);

    const { server, close } = await createMobileServer({
      broadcaster,
      roots: [],
      options: { token: TOKEN, port: 0, hostname: '127.0.0.1', homeDir },
    });
    servers.push({ close });
    const port = server.address().port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise(r => ws.on('open', r));

    // Send 5KB first frame (exceeds 4KB cap)
    ws.send('x'.repeat(5000));

    const closeCode = await new Promise((resolve) => {
      ws.on('close', (code) => resolve(code));
      setTimeout(() => resolve(null), 3000);
    });
    expect(closeCode).toBe(4401);
  });

  it('WS-7: Origin mismatch → upgrade rejected', { timeout: 8000 }, async () => {
    const broadcaster = new Broadcaster();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-home-'));
    tmpDirs.push(homeDir);

    const { server, close } = await createMobileServer({
      broadcaster,
      roots: [],
      options: { token: TOKEN, port: 0, hostname: '127.0.0.1', homeDir },
    });
    servers.push({ close });
    const port = server.address().port;

    // Connect with mismatched Origin
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: 'http://evil.example.com' },
    });

    // A rejected upgrade must NOT open and must NOT deliver a ready frame.
    // If someone removes the Origin check in wsHub.js, the handshake succeeds,
    // `opened` flips true, and this test fails — the whole point of WS-7.
    let opened = false;
    let gotReady = false;
    let errored = false;
    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    });
    ws.on('message', (data) => {
      try { if (JSON.parse(data.toString()).type === 'ready') gotReady = true; } catch {}
    });
    await new Promise((resolve) => {
      ws.on('close', () => resolve());
      ws.on('error', () => { errored = true; resolve(); });
      setTimeout(resolve, 3000);
    });

    expect(opened).toBe(false);   // upgrade rejected pre-open
    expect(gotReady).toBe(false); // never authenticated
    expect(errored).toBe(true);   // client saw the 403/destroy as a handshake error
  });

  it('WS-8: late-connecting socket receives replay of latest snapshot', { timeout: 8000 }, async () => {
    const root = makeTmpRoot('TASK-008');
    tmpDirs.push(root);
    const broadcaster = new Broadcaster();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-home-'));
    tmpDirs.push(homeDir);

    const { server, close } = await createMobileServer({
      broadcaster,
      roots: [root],
      options: { token: TOKEN, port: 0, hostname: '127.0.0.1', homeDir },
    });
    servers.push({ close });
    const port = server.address().port;

    // Push a snapshot before any socket connects
    broadcaster.emit(makeSnapshot('sess-replay', 1, 'TASK-008'));

    // Now connect a new socket — should receive turn in replay
    const { ws, messages } = await connectAndAuth(`ws://127.0.0.1:${port}`, TOKEN);
    await waitFor(() => messages.find(m => m.type === 'ready'));
    await waitFor(() => messages.find(m => m.type === 'turn'), 3000);
    const turn = messages.find(m => m.type === 'turn');
    expect(turn).toBeDefined();
    expect(turn.snapshot.sessionId).toBe('sess-replay');

    ws.close();
  });
});
