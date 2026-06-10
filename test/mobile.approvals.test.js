import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalJson,
  computeDigest,
  validateTaskId,
  resolveTask,
  writeApprovalToken,
} from '../src/mobile/approvals.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffviewer-approvals-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- helpers ----

function makeRoot(taskId = null) {
  const root = fs.mkdtempSync(path.join(tmpDir, 'root-'));
  const claimed = path.join(root, '.agents', 'claimed');
  fs.mkdirSync(claimed, { recursive: true });
  if (taskId) {
    writeTaskFile(claimed, taskId);
  }
  return root;
}

function writeTaskFile(claimedDir, taskId, content = null) {
  const filename = `hostname_1234_${taskId}.md`;
  const body = content ?? `---\nid: ${taskId}\ntype: implementation\n---\n## Context\nHello\n`;
  fs.writeFileSync(path.join(claimedDir, filename), body);
}

// ---- canonicalJson ----

describe('canonicalJson', () => {
  it('APR-1 sorts object keys recursively', () => {
    const result = canonicalJson({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it('APR-2 nested objects are sorted', () => {
    const result = canonicalJson({ b: { z: 1, a: 2 }, a: 'x' });
    expect(result).toBe('{"a":"x","b":{"a":2,"z":1}}');
  });

  it('APR-3 arrays keep order (not sorted)', () => {
    const result = canonicalJson([3, 1, 2]);
    expect(result).toBe('[3,1,2]');
  });

  it('APR-4 null serializes as null', () => {
    expect(canonicalJson(null)).toBe('null');
  });

  it('APR-5 primitives pass through', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hello')).toBe('"hello"');
  });
});

// ---- computeDigest ----

describe('computeDigest', () => {
  const snap = {
    sessionId: 'sess-abc',
    turnNumber: 1,
    task: 'TASK-001',
    events: [{ tool: 'edit', path: 'src/foo.js' }],
  };

  it('APR-6 returns a 64-char hex string', () => {
    const digest = computeDigest(snap);
    expect(typeof digest).toBe('string');
    expect(digest).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(digest)).toBe(true);
  });

  it('APR-7 digest is stable (deterministic)', () => {
    expect(computeDigest(snap)).toBe(computeDigest(snap));
  });

  it('APR-8 different task → different digest', () => {
    const snap2 = { ...snap, task: 'TASK-002' };
    expect(computeDigest(snap)).not.toBe(computeDigest(snap2));
  });

  it('APR-9 null task → different digest than non-null task', () => {
    const snapNull = { ...snap, task: null };
    expect(computeDigest(snap)).not.toBe(computeDigest(snapNull));
  });

  it('APR-10 task field normalized to null when absent', () => {
    const snapNoTask = { sessionId: 'sess-abc', turnNumber: 1, events: [] };
    const snapNullTask = { sessionId: 'sess-abc', turnNumber: 1, task: null, events: [] };
    expect(computeDigest(snapNoTask)).toBe(computeDigest(snapNullTask));
  });
});

// ---- validateTaskId ----

describe('validateTaskId', () => {
  it('APR-11 accepts valid IDs', () => {
    expect(validateTaskId('TASK-001')).toBe(true);
    expect(validateTaskId('task.1')).toBe(true);
    expect(validateTaskId('a_b-c.d')).toBe(true);
    expect(validateTaskId('ABC123')).toBe(true);
  });

  it('APR-12 rejects "." and ".."', () => {
    expect(validateTaskId('.')).toBe(false);
    expect(validateTaskId('..')).toBe(false);
  });

  it('APR-13 rejects path traversal (slash)', () => {
    expect(validateTaskId('../x')).toBe(false);
    expect(validateTaskId('a/b')).toBe(false);
  });

  it('APR-14 rejects empty string', () => {
    expect(validateTaskId('')).toBe(false);
  });

  it('APR-15 rejects spaces and special chars', () => {
    expect(validateTaskId('task 1')).toBe(false);
    expect(validateTaskId('task@1')).toBe(false);
    expect(validateTaskId('task!1')).toBe(false);
  });
});

// ---- resolveTask ----

describe('resolveTask', () => {
  it('APR-16 resolves task from single root', () => {
    const root = makeRoot('TASK-001');
    const result = resolveTask([root], 'TASK-001');
    expect(result).toEqual({ root });
  });

  it('APR-17 task-not-claimed when no matching file', () => {
    const root = makeRoot();
    const result = resolveTask([root], 'TASK-999');
    expect(result).toEqual({ error: 'task-not-claimed' });
  });

  it('APR-18 ambiguous when task found in 2 roots', () => {
    const root1 = makeRoot('TASK-001');
    const root2 = makeRoot('TASK-001');
    const result = resolveTask([root1, root2], 'TASK-001');
    expect(result).toEqual({ error: 'ambiguous-task' });
  });

  it('APR-19 resolves across 2 roots, returns correct one', () => {
    const root1 = makeRoot('TASK-001');
    const root2 = makeRoot('TASK-002');
    const r1 = resolveTask([root1, root2], 'TASK-001');
    expect(r1).toEqual({ root: root1 });
    const r2 = resolveTask([root1, root2], 'TASK-002');
    expect(r2).toEqual({ root: root2 });
  });

  it('APR-20 skips symlinks in claimed dir', () => {
    const root = makeRoot();
    const claimedDir = path.join(root, '.agents', 'claimed');
    // create real file elsewhere then symlink into claimed
    const realFile = path.join(tmpDir, 'real-task.md');
    fs.writeFileSync(realFile, `---\nid: TASK-SYM\ntype: impl\n---\n`);
    fs.symlinkSync(realFile, path.join(claimedDir, 'hostname_99_TASK-SYM.md'));

    const result = resolveTask([root], 'TASK-SYM');
    expect(result).toEqual({ error: 'task-not-claimed' });
  });

  it('APR-21 task-not-claimed when no claimed dir exists', () => {
    // root with no .agents at all
    const root = fs.mkdtempSync(path.join(tmpDir, 'empty-root-'));
    const result = resolveTask([root], 'TASK-001');
    expect(result).toEqual({ error: 'task-not-claimed' });
  });
});

// ---- writeApprovalToken ----

describe('writeApprovalToken', () => {
  it('APR-22 happy path: creates file with audit JSON', () => {
    const root = makeRoot('TASK-001');
    const audit = { digest: 'abc123', sessionId: 'sess-1' };
    const result = writeApprovalToken(root, 'TASK-001', audit);
    expect(result).not.toHaveProperty('already');

    const tokenPath = path.join(root, '.agents', 'approvals', 'TASK-001.approved');
    expect(fs.existsSync(tokenPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    expect(content).toMatchObject({ digest: 'abc123', sessionId: 'sess-1' });
    expect(typeof content.approvedAt).toBe('string');
  });

  it('APR-23 existing token → returns {already:true}, content untouched', () => {
    const root = makeRoot('TASK-001');
    const audit = { digest: 'first' };
    writeApprovalToken(root, 'TASK-001', audit);

    const result = writeApprovalToken(root, 'TASK-001', { digest: 'second' });
    expect(result).toEqual({ already: true });

    const tokenPath = path.join(root, '.agents', 'approvals', 'TASK-001.approved');
    const content = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    expect(content.digest).toBe('first');
  });

  it('APR-24 creates approvals dir if absent', () => {
    const root = makeRoot('TASK-001');
    // approvals dir not created yet
    const approvalsDir = path.join(root, '.agents', 'approvals');
    expect(fs.existsSync(approvalsDir)).toBe(false);

    writeApprovalToken(root, 'TASK-001', {});
    expect(fs.existsSync(approvalsDir)).toBe(true);
  });

  it('APR-25 refuses if .agents is a symlink', () => {
    const root = fs.mkdtempSync(path.join(tmpDir, 'symroot-'));
    const realAgents = path.join(tmpDir, 'real-agents');
    fs.mkdirSync(realAgents);
    const agentsLink = path.join(root, '.agents');
    fs.symlinkSync(realAgents, agentsLink);

    expect(() => writeApprovalToken(root, 'TASK-001', {})).toThrow();
  });

  it('APR-26 refuses if approvals is a symlink', () => {
    const root = makeRoot('TASK-001');
    const approvalsDir = path.join(root, '.agents', 'approvals');
    const realDir = path.join(tmpDir, 'real-approvals');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, approvalsDir);

    expect(() => writeApprovalToken(root, 'TASK-001', {})).toThrow();
  });

  it('APR-27 approvals dir created with mode 0700, token file mode 0600', () => {
    const root = makeRoot('TASK-001');
    writeApprovalToken(root, 'TASK-001', { digest: 'test' });

    const approvalsDir = path.join(root, '.agents', 'approvals');
    const dirMode = fs.statSync(approvalsDir).mode & 0o777;
    expect(dirMode).toBe(0o700);

    const tokenPath = path.join(approvalsDir, 'TASK-001.approved');
    const fileMode = fs.statSync(tokenPath).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });
});
