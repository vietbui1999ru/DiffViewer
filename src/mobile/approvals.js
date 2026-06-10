import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---- canonicalJson ----

/**
 * canonicalJson(value) -> string
 *
 * JSON serialization with recursively sorted object keys.
 * Arrays keep their natural order (only object keys are sorted).
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const sorted = Object.keys(value)
    .sort()
    .map(k => JSON.stringify(k) + ':' + canonicalJson(value[k]))
    .join(',');
  return '{' + sorted + '}';
}

// ---- computeDigest ----

/**
 * computeDigest(snapshot) -> sha256hex string
 *
 * Digest input: canonicalJson({sessionId, turnNumber, task, events})
 * task is normalized to null if absent/undefined so a snapshot without
 * a task field digests identically to one with task: null.
 */
export function computeDigest(snapshot) {
  const normalized = {
    sessionId: snapshot.sessionId,
    turnNumber: snapshot.turnNumber,
    task: snapshot.task ?? null,
    events: snapshot.events,
  };
  const payload = canonicalJson(normalized);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ---- validateTaskId ----

const TASK_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * validateTaskId(taskId) -> bool
 *
 * Accepts only ^[A-Za-z0-9._-]+$ and refuses '.' and '..' explicitly.
 */
export function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0) return false;
  if (taskId === '.' || taskId === '..') return false;
  return TASK_ID_RE.test(taskId);
}

// ---- resolveTask ----

/**
 * Parse the first 'id:' value between --- fences in a task markdown file.
 * Returns null if not found.
 */
function parseTaskId(content) {
  const lines = content.split('\n');
  let inFrontmatter = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        break; // closing fence
      }
    }
    if (inFrontmatter) {
      const m = trimmed.match(/^id:\s*(.+)$/);
      if (m) return m[1].trim();
    }
  }
  return null;
}

/**
 * resolveTask(roots, taskId) -> {root} | {error: 'task-not-claimed' | 'ambiguous-task'}
 *
 * For each root, scans <root>/.agents/claimed/*.md using lstat.
 * Skips symlinks. Parses first 'id:' between --- fences.
 * Returns {root} if exactly one match, error otherwise.
 */
export function resolveTask(roots, taskId) {
  const matches = [];

  for (const root of roots) {
    const claimedDir = path.join(root, '.agents', 'claimed');

    let entries;
    try {
      entries = fs.readdirSync(claimedDir);
    } catch {
      continue; // dir absent → no tasks here
    }

    for (const name of entries) {
      if (!name.endsWith('.md')) continue;

      const filePath = path.join(claimedDir, name);

      // lstat and skip symlinks
      let stat;
      try {
        stat = fs.lstatSync(filePath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (!stat.isFile()) continue;

      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const parsed = parseTaskId(content);
      if (parsed === taskId) {
        matches.push(root);
        break; // one match per root is enough; keep scanning other roots
      }
    }
  }

  if (matches.length === 0) return { error: 'task-not-claimed' };
  if (matches.length > 1) return { error: 'ambiguous-task' };
  return { root: matches[0] };
}

// ---- writeApprovalToken ----

/**
 * writeApprovalToken(root, taskId, auditObj) -> {} | {already: true}
 *
 * Security hardening:
 *   - lstat <root>/.agents: must be a real dir (not symlink)
 *   - lstat <root>/.agents/approvals: if exists, must be a real dir (not symlink)
 *   - mkdir approvals if absent
 *   - Write <taskId>.approved with flag 'wx' (exclusive create)
 *   - If EEXIST → return {already: true} without touching the file
 *
 * Content: JSON {approvedAt: iso8601, ...auditObj}
 */
export function writeApprovalToken(root, taskId, auditObj) {
  const agentsPath = path.join(root, '.agents');

  // lstat .agents — must be real dir
  const agentsStat = fs.lstatSync(agentsPath); // throws if absent
  if (agentsStat.isSymbolicLink()) {
    throw new Error(`[approvals] .agents is a symlink: ${agentsPath}`);
  }
  if (!agentsStat.isDirectory()) {
    throw new Error(`[approvals] .agents is not a directory: ${agentsPath}`);
  }

  const approvalsPath = path.join(agentsPath, 'approvals');

  // lstat approvals if it exists
  try {
    const approvalsStat = fs.lstatSync(approvalsPath);
    if (approvalsStat.isSymbolicLink()) {
      throw new Error(`[approvals] approvals is a symlink: ${approvalsPath}`);
    }
    if (!approvalsStat.isDirectory()) {
      throw new Error(`[approvals] approvals is not a directory: ${approvalsPath}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Create the approvals dir
      fs.mkdirSync(approvalsPath, { mode: 0o700 });
    } else {
      throw err;
    }
  }

  const tokenPath = path.join(approvalsPath, `${taskId}.approved`);
  const content = JSON.stringify({
    approvedAt: new Date().toISOString(),
    ...auditObj,
  });

  try {
    fs.writeFileSync(tokenPath, content, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code === 'EEXIST') {
      return { already: true };
    }
    throw err;
  }

  return {};
}
