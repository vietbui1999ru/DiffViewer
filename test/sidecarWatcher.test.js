import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSidecarWatcher } from '../src/sidecarWatcher.js';
import { SessionRegistry } from '../src/turnBuffer.js';
import { Broadcaster } from '../src/broadcaster.js';

// Helper: write a valid turn file atomically (simulating the adapter write protocol)
function writeTurn(sessionDir, n, events, extra = {}) {
  const sessionId = path.basename(sessionDir);
  const payload = {
    version: 1,
    sessionId,
    harness: 'claude-code',
    task: null,
    turnNumber: n,
    startedAt: Date.now() - 100,
    completedAt: Date.now(),
    events,
    ...extra,
  };
  const tmpFile = path.join(sessionDir, `.tmp-turn-${n}.json`);
  const finalFile = path.join(sessionDir, `turn-${n}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(payload));
  fs.renameSync(tmpFile, finalFile);
  return finalFile;
}

// Helper: create a tmp repo dir with .diffviewer/turns/<sessionId>/
function makeTmpRepo(sessionId = 'sess-abc') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffviewer-test-'));
  const sessionDir = path.join(root, '.diffviewer', 'turns', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  return { root, sessionDir, sessionId };
}

// Collect emitted snapshots into an array
function collectEmits(broadcaster) {
  const emitted = [];
  const origEmit = broadcaster.emit.bind(broadcaster);
  broadcaster.emit = (s) => { emitted.push(s); origEmit(s); };
  return emitted;
}

// Wait for a condition with timeout
function waitFor(fn, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      try {
        const result = fn();
        if (result) { resolve(result); return; }
      } catch {}
      if (Date.now() - start > timeout) {
        reject(new Error(`waitFor timed out after ${timeout}ms`));
        return;
      }
      setTimeout(check, 30);
    };
    check();
  });
}

let watchers = [];
afterEach(() => {
  for (const w of watchers) { try { w.close(); } catch {} }
  watchers = [];
});

describe('sidecarWatcher — file write -> SSE snapshot', () => {
  it('SW1 turn file emitted as TurnSnapshot with normalized events', { timeout: 8000 }, async () => {
    const { root, sessionDir, sessionId } = makeTmpRepo('sw1-session');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    // Allow OS watcher to register before writing (macOS kqueue latency)
    await new Promise(r => setTimeout(r, 50));
    writeTurn(sessionDir, 1, [
      { tool: 'Write', path: 'src/foo.js', oldContent: '', newContent: 'console.log("hi");\n' },
      { tool: 'Edit', path: 'src/bar.js', oldContent: 'old\n', newContent: 'new\n' },
    ]);

    await waitFor(() => emitted.length >= 1, 6000);

    expect(emitted).toHaveLength(1);
    const snap = emitted[0];
    expect(snap.sessionId).toBe(sessionId);
    expect(snap.events).toHaveLength(2);

    const writeEv = snap.events.find(e => e.path === 'src/foo.js');
    expect(writeEv.tool).toBe('write');
    expect(writeEv.isNew).toBe(true);
    expect(writeEv.unifiedDiff).toContain('@@');

    const editEv = snap.events.find(e => e.path === 'src/bar.js');
    expect(editEv.tool).toBe('edit');
    expect(editEv.isNew).toBe(false);
    expect(editEv.unifiedDiff).toContain('@@');
  });

  it('SW2 tmp-prefixed and non-matching filenames are ignored', async () => {
    const { root, sessionDir, sessionId } = makeTmpRepo('sw2-session');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    // Write files that must NOT trigger ingestion — invalid JSON variants
    fs.writeFileSync(path.join(sessionDir, '.tmp-turn-1.json'), '{}');
    fs.writeFileSync(path.join(sessionDir, 'notes.txt'), 'ignore me');
    fs.writeFileSync(path.join(sessionDir, 'pending.jsonl'), '{}');

    // Write a FULLY VALID payload under a non-matching basename.
    // If the basename filter is absent, this file WOULD produce an emit.
    // Only a correct TURN_FILE_RE check keeps emitted.length === 0.
    const validPayload = JSON.stringify({
      version: 1,
      sessionId,
      harness: 'claude-code',
      task: null,
      turnNumber: 1,
      startedAt: Date.now() - 100,
      completedAt: Date.now(),
      events: [{ tool: 'Write', path: 'x.js', oldContent: '', newContent: 'x\n' }],
    });
    fs.writeFileSync(path.join(sessionDir, 'turn-1.json.bak'), validPayload);

    // Small delay to let watcher fire if it would
    await new Promise(r => setTimeout(r, 300));
    expect(emitted).toHaveLength(0);
  });

  it('SW3 malformed JSON: log to stderr, leave file in place, no crash', async () => {
    const { root, sessionDir } = makeTmpRepo('sw3-session');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    const badFile = path.join(sessionDir, 'turn-1.json');
    fs.writeFileSync(badFile, '{ this is not json }');

    await waitFor(() => stderrSpy.mock.calls.length > 0, 3000);

    stderrSpy.mockRestore();
    expect(emitted).toHaveLength(0);
    // File must still be there (not unlinked on error)
    expect(fs.existsSync(badFile)).toBe(true);
  });

  it('SW3b wrong version field: log, leave file, no emit', async () => {
    const { root, sessionDir, sessionId } = makeTmpRepo('sw3b-session');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    const badFile = writeTurn(sessionDir, 1,
      [{ tool: 'Write', path: 'x.js', oldContent: '', newContent: 'x\n' }],
      { version: 99 }  // invalid version
    );

    await waitFor(() => stderrSpy.mock.calls.length > 0, 3000);
    stderrSpy.mockRestore();

    expect(emitted).toHaveLength(0);
    expect(fs.existsSync(badFile)).toBe(true);
  });

  it('SW4 consumed file is unlinked after successful broadcast', { timeout: 8000 }, async () => {
    const { root, sessionDir } = makeTmpRepo('sw4-session');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    await new Promise(r => setTimeout(r, 50));
    const file = writeTurn(sessionDir, 1, [
      { tool: 'Write', path: 'a.js', oldContent: '', newContent: 'a\n' },
    ]);

    await waitFor(() => emitted.length >= 1, 6000);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('SW5 startup scan ingests pre-existing files in ascending N order', () => {
    const { root, sessionDir } = makeTmpRepo('sw5-session');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    // Write turns BEFORE creating the watcher (simulating server down)
    writeTurn(sessionDir, 3, [{ tool: 'Write', path: 'c.js', oldContent: '', newContent: 'c\n' }]);
    writeTurn(sessionDir, 1, [{ tool: 'Write', path: 'a.js', oldContent: '', newContent: 'a\n' }]);
    writeTurn(sessionDir, 2, [{ tool: 'Edit', path: 'b.js', oldContent: 'old\n', newContent: 'new\n' }]);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    // Startup scan is synchronous — all three should be emitted immediately
    expect(emitted).toHaveLength(3);
    // Each turn-N yields one snapshot; the session turn counter increments for each
    expect(emitted.map(s => s.events[0].path)).toEqual(['a.js', 'b.js', 'c.js']);
  });

  it('SW6 two sessions in same repo do not cross-contaminate', { timeout: 8000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffviewer-test-'));
    const sessADir = path.join(root, '.diffviewer', 'turns', 'session-A');
    const sessBDir = path.join(root, '.diffviewer', 'turns', 'session-B');
    fs.mkdirSync(sessADir, { recursive: true });
    fs.mkdirSync(sessBDir, { recursive: true });

    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    await new Promise(r => setTimeout(r, 50));
    writeTurn(sessADir, 1, [{ tool: 'Write', path: 'only-in-a.js', oldContent: '', newContent: 'a\n' }]);
    writeTurn(sessBDir, 1, [{ tool: 'Write', path: 'only-in-b.js', oldContent: '', newContent: 'b\n' }]);

    await waitFor(() => emitted.length >= 2, 6000);

    const snapA = emitted.find(s => s.sessionId === 'session-A');
    const snapB = emitted.find(s => s.sessionId === 'session-B');

    expect(snapA).toBeDefined();
    expect(snapA.events.map(e => e.path)).toEqual(['only-in-a.js']);

    expect(snapB).toBeDefined();
    expect(snapB.events.map(e => e.path)).toEqual(['only-in-b.js']);

    // No cross-contamination
    expect(snapA.events.some(e => e.path === 'only-in-b.js')).toBe(false);
    expect(snapB.events.some(e => e.path === 'only-in-a.js')).toBe(false);
  });
});

describe('sidecarWatcher — task propagation (§7)', () => {
  it('SW-TASK1 snapshot.task set from turn file task field', { timeout: 8000 }, async () => {
    const { root, sessionDir, sessionId } = makeTmpRepo('sw-task1-session');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    await new Promise(r => setTimeout(r, 50));
    // Write turn with a real task id
    writeTurn(sessionDir, 1, [
      { tool: 'Write', path: 'x.js', oldContent: '', newContent: 'x\n' },
    ], { task: 'TASK-007' });

    await waitFor(() => emitted.length >= 1, 6000);
    expect(emitted[0].task).toBe('TASK-007');
  });

  it('SW-TASK2 snapshot.task is null when turn file has task: null', { timeout: 8000 }, async () => {
    const { root, sessionDir, sessionId } = makeTmpRepo('sw-task2-session');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    await new Promise(r => setTimeout(r, 50));
    writeTurn(sessionDir, 1, [
      { tool: 'Write', path: 'y.js', oldContent: '', newContent: 'y\n' },
    ], { task: null });

    await waitFor(() => emitted.length >= 1, 6000);
    expect(emitted[0].task).toBeNull();
  });

  it('SW-TASK3 snapshot.task is null when turn file task field absent', { timeout: 8000 }, async () => {
    const { root, sessionDir, sessionId } = makeTmpRepo('sw-task3-session');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    await new Promise(r => setTimeout(r, 50));
    // writeTurn with no task override — payload gets task:null by default
    writeTurn(sessionDir, 1, [
      { tool: 'Write', path: 'z.js', oldContent: '', newContent: 'z\n' },
    ]);

    await waitFor(() => emitted.length >= 1, 6000);
    expect(emitted[0].task).toBeNull();
  });
});

describe('sidecarWatcher — security hardening', () => {
  it('SW-SEC1 startup scan skips symlink session dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffviewer-test-'));
    const turnsDir = path.join(root, '.diffviewer', 'turns');
    fs.mkdirSync(turnsDir, { recursive: true });

    // Create a real session dir OUTSIDE turnsDir
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffviewer-outside-'));
    const outsideSessionDir = path.join(outsideDir, 'evil-sess');
    fs.mkdirSync(outsideSessionDir);
    // Pre-stage a valid turn file in the outside dir
    const payload = JSON.stringify({
      version: 1,
      sessionId: 'evil-sess',
      harness: 'claude-code',
      task: null,
      turnNumber: 1,
      startedAt: Date.now() - 100,
      completedAt: Date.now(),
      events: [{ tool: 'Write', path: 'evil.js', oldContent: '', newContent: 'evil\n' }],
    });
    fs.writeFileSync(path.join(outsideSessionDir, 'turn-1.json'), payload);

    // Plant symlink inside turnsDir pointing at outsideSessionDir
    fs.symlinkSync(outsideSessionDir, path.join(turnsDir, 'evil-sess'));

    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    // Startup scan is synchronous — symlink session dir must be skipped
    expect(emitted).toHaveLength(0);
  });

  it('SW-SEC2 fs.watch callback rejects filePath that escapes turnsDir', { timeout: 5000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffviewer-test-'));
    const turnsDir = path.join(root, '.diffviewer', 'turns');
    fs.mkdirSync(turnsDir, { recursive: true });

    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    // Create a turn file OUTSIDE turnsDir that matches TURN_FILE_RE name
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffviewer-outside-'));
    const outsideFile = path.join(outsideDir, 'turn-1.json');
    const payload = JSON.stringify({
      version: 1,
      sessionId: 'escape-sess',
      harness: 'claude-code',
      task: null,
      turnNumber: 1,
      startedAt: Date.now() - 100,
      completedAt: Date.now(),
      events: [{ tool: 'Write', path: 'escape.js', oldContent: '', newContent: 'escape\n' }],
    });
    fs.writeFileSync(outsideFile, payload);

    // Plant a symlink so that turnsDir/escape-sess/turn-1.json resolves outside
    const escapeSessDir = path.join(turnsDir, 'escape-sess');
    fs.symlinkSync(outsideDir, escapeSessDir);

    // Wait a bit to confirm no emit fires
    await new Promise(r => setTimeout(r, 500));
    expect(emitted).toHaveLength(0);

    // The outside file must still exist (not unlinked by our code)
    expect(fs.existsSync(outsideFile)).toBe(true);
  });
});

describe('sidecarWatcher — POST path still works (existing suite compatibility)', () => {
  it('SW7 registry and broadcaster shared between watcher and POST path', async () => {
    const { root } = makeTmpRepo('sw7-session');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);

    // Watcher created but we only test the POST path here
    const watcher = createSidecarWatcher([root], { registry, broadcaster });
    watchers.push(watcher);

    const { normalizeEvent } = await import('../src/normalizer.js');

    // Simulate what POST /event + /turn-end does
    registry.add('post-session', normalizeEvent({
      tool: 'Write', path: 'post.js', oldContent: '', newContent: 'post\n',
    }));
    const snapshot = registry.flush('post-session');
    broadcaster.emit(snapshot);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].sessionId).toBe('post-session');
    expect(emitted[0].events[0].path).toBe('post.js');
  });
});

describe('sidecarWatcher — open-once-then-notify (§6 / decision 6)', () => {
  it('SW-OPEN-01 first turn fires onFirstTurn once; second fires onSubsequentTurn', { timeout: 8000 }, async () => {
    const { root, sessionDir } = makeTmpRepo('sw-open-1');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);
    const onFirstTurn = vi.fn();
    const onSubsequentTurn = vi.fn();

    const watcher = createSidecarWatcher([root], { registry, broadcaster, onFirstTurn, onSubsequentTurn });
    watchers.push(watcher);

    await new Promise((r) => setTimeout(r, 50));
    writeTurn(sessionDir, 1, [{ tool: 'Write', path: 'a.js', oldContent: '', newContent: 'a\n' }]);
    await waitFor(() => emitted.length >= 1, 6000);

    writeTurn(sessionDir, 2, [{ tool: 'Edit', path: 'a.js', oldContent: 'a\n', newContent: 'b\n' }]);
    await waitFor(() => emitted.length >= 2, 6000);

    expect(onFirstTurn).toHaveBeenCalledTimes(1);
    expect(onFirstTurn).toHaveBeenCalledWith('sw-open-1');
    expect(onSubsequentTurn).toHaveBeenCalledTimes(1);
    expect(onSubsequentTurn).toHaveBeenCalledWith('sw-open-1', expect.objectContaining({ sessionId: 'sw-open-1' }));
  });

  it('SW-OPEN-02 a second session triggers onFirstTurn independently', { timeout: 8000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffviewer-test-'));
    const sessADir = path.join(root, '.diffviewer', 'turns', 's2-A');
    const sessBDir = path.join(root, '.diffviewer', 'turns', 's2-B');
    fs.mkdirSync(sessADir, { recursive: true });
    fs.mkdirSync(sessBDir, { recursive: true });

    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);
    const onFirstTurn = vi.fn();
    const onSubsequentTurn = vi.fn();

    const watcher = createSidecarWatcher([root], { registry, broadcaster, onFirstTurn, onSubsequentTurn });
    watchers.push(watcher);

    await new Promise((r) => setTimeout(r, 50));
    writeTurn(sessADir, 1, [{ tool: 'Write', path: 'a.js', oldContent: '', newContent: 'a\n' }]);
    await waitFor(() => emitted.length >= 1, 6000);
    writeTurn(sessBDir, 1, [{ tool: 'Write', path: 'b.js', oldContent: '', newContent: 'b\n' }]);
    await waitFor(() => emitted.length >= 2, 6000);

    const firstArgs = onFirstTurn.mock.calls.map((c) => c[0]);
    expect(firstArgs).toEqual(expect.arrayContaining(['s2-A', 's2-B']));
    expect(onFirstTurn).toHaveBeenCalledTimes(2);
  });

  it('SW-OPEN-03 startup scan does NOT trigger onFirstTurn; first LIVE turn does', { timeout: 8000 }, async () => {
    const { root, sessionDir } = makeTmpRepo('sw-open-3');
    const registry = new SessionRegistry();
    const broadcaster = new Broadcaster();
    const emitted = collectEmits(broadcaster);
    const onFirstTurn = vi.fn();
    const onSubsequentTurn = vi.fn();

    // Pre-existing turns written BEFORE the watcher starts -> startup scan ingests them
    writeTurn(sessionDir, 1, [{ tool: 'Write', path: 'p.js', oldContent: '', newContent: 'p\n' }]);
    writeTurn(sessionDir, 2, [{ tool: 'Edit', path: 'p.js', oldContent: 'p\n', newContent: 'q\n' }]);

    const watcher = createSidecarWatcher([root], { registry, broadcaster, onFirstTurn, onSubsequentTurn });
    watchers.push(watcher);

    // Startup scan is synchronous — two pre-existing turns already emitted, no callbacks
    expect(emitted).toHaveLength(2);
    expect(onFirstTurn).not.toHaveBeenCalled();
    expect(onSubsequentTurn).not.toHaveBeenCalled();

    // A live turn for the same session opens the tab (Set was not pre-populated by scan)
    await new Promise((r) => setTimeout(r, 50));
    writeTurn(sessionDir, 3, [{ tool: 'Edit', path: 'p.js', oldContent: 'q\n', newContent: 'r\n' }]);
    await waitFor(() => emitted.length >= 3, 6000);

    expect(onFirstTurn).toHaveBeenCalledTimes(1);
    expect(onFirstTurn).toHaveBeenCalledWith('sw-open-3');
    expect(onSubsequentTurn).not.toHaveBeenCalled();
  });
});
