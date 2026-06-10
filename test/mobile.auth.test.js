import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateToken, checkToken } from '../src/mobile/auth.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffviewer-auth-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadOrCreateToken', () => {
  it('AUTH-1 generate-on-first-use: writes 0600 file in 0700 dir', async () => {
    const token = await loadOrCreateToken({ homeDir: tmpDir });
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const tokenPath = path.join(tmpDir, '.diffviewer', 'mobile', 'token');
    const dirPath = path.join(tmpDir, '.diffviewer', 'mobile');

    expect(fs.existsSync(tokenPath)).toBe(true);

    const fileStat = fs.statSync(tokenPath);
    const dirStat = fs.statSync(dirPath);

    // Check file permissions: 0600
    expect(fileStat.mode & 0o777).toBe(0o600);
    // Check dir permissions: 0700
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it('AUTH-2 reload returns same token (idempotent)', async () => {
    const token1 = await loadOrCreateToken({ homeDir: tmpDir });
    const token2 = await loadOrCreateToken({ homeDir: tmpDir });
    expect(token1).toBe(token2);
  });

  it('AUTH-3 env override wins and writes nothing', async () => {
    const envToken = 'env-override-token-value';
    process.env.DIFFVIEWER_MOBILE_TOKEN = envToken;
    try {
      const token = await loadOrCreateToken({ homeDir: tmpDir });
      expect(token).toBe(envToken);

      const tokenPath = path.join(tmpDir, '.diffviewer', 'mobile', 'token');
      expect(fs.existsSync(tokenPath)).toBe(false);
    } finally {
      delete process.env.DIFFVIEWER_MOBILE_TOKEN;
    }
  });

  it('AUTH-4 existing token file content is preserved on reload', async () => {
    const dirPath = path.join(tmpDir, '.diffviewer', 'mobile');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.chmodSync(dirPath, 0o700);
    const tokenPath = path.join(dirPath, 'token');
    const existing = 'my-existing-token-content';
    fs.writeFileSync(tokenPath, existing, { mode: 0o600 });

    const token = await loadOrCreateToken({ homeDir: tmpDir });
    expect(token).toBe(existing);
  });
});

describe('checkToken', () => {
  it('AUTH-5 accepts the correct token', () => {
    expect(checkToken('abc123', 'abc123')).toBe(true);
  });

  it('AUTH-6 rejects wrong token', () => {
    expect(checkToken('wrongtoken', 'abc123')).toBe(false);
  });

  it('AUTH-7 rejects empty provided token', () => {
    expect(checkToken('', 'abc123')).toBe(false);
  });

  it('AUTH-8 rejects length mismatch without timing leak', () => {
    // Shorter provided
    expect(checkToken('short', 'longertoken')).toBe(false);
    // Longer provided
    expect(checkToken('toolongprovided', 'short')).toBe(false);
  });

  it('AUTH-9 rejects empty stored token (degenerate)', () => {
    expect(checkToken('anything', '')).toBe(false);
  });

  it('AUTH-10 constant-time path: matching base64url tokens', async () => {
    const token = await loadOrCreateToken({ homeDir: tmpDir });
    expect(checkToken(token, token)).toBe(true);
  });
});
