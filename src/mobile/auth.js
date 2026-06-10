import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * loadOrCreateToken(opts) -> string
 *
 * opts.homeDir: injectable home directory (defaults to os.homedir())
 *
 * Priority:
 *   1. DIFFVIEWER_MOBILE_TOKEN env var — returned as-is, never written to disk
 *   2. ~/.diffviewer/mobile/token file — read if exists
 *   3. Generate 32 random bytes base64url, write to file (dir 0700, file 0600)
 */
export async function loadOrCreateToken(opts = {}) {
  // Env override wins — never written to disk
  if (process.env.DIFFVIEWER_MOBILE_TOKEN) {
    return process.env.DIFFVIEWER_MOBILE_TOKEN;
  }

  const homeDir = opts.homeDir ?? (await import('node:os')).default.homedir();
  const tokenDir = path.join(homeDir, '.diffviewer', 'mobile');
  const tokenPath = path.join(tokenDir, 'token');

  // Read existing token
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8');
    return existing.trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Generate new token
  const token = crypto.randomBytes(32).toString('base64url');

  // Create dir with 0700
  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  // Ensure dir mode even if it already existed with looser perms
  fs.chmodSync(tokenDir, 0o700);

  // Write with 0600 using 'wx' to avoid race (fail if exists)
  try {
    fs.writeFileSync(tokenPath, token, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Another process wrote it — read theirs
      return fs.readFileSync(tokenPath, 'utf8').trim();
    }
    throw err;
  }

  return token;
}

/**
 * checkToken(provided, token) -> bool
 *
 * Constant-time comparison. Never uses === on the raw strings.
 * Length pre-check avoids throwing in timingSafeEqual (different-length buffers throw).
 * Returns false immediately on length mismatch (does NOT leak content, only length,
 * which is already known from the wire since the token is sent in full).
 */
export function checkToken(provided, token) {
  if (typeof provided !== 'string' || typeof token !== 'string') return false;
  if (provided.length === 0 || token.length === 0) return false;

  // Encode to UTF-8 bytes for timingSafeEqual
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(token, 'utf8');

  // Length pre-check: different lengths → false (no timing leak on content)
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}
