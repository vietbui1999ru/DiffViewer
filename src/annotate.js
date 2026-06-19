import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Resolve the bus (.agents) directory for a task. Prefer an explicit env override,
// then the first watched root that already has a .agents dir, then the first root's
// .agents path (created on demand by the writer), finally the cwd.
function resolveBus(roots, env) {
  if (env.DIFFVIEWER_ANNOTATE_BUS) return env.DIFFVIEWER_ANNOTATE_BUS;
  for (const r of roots) {
    const candidate = path.join(r, '.agents');
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  if (roots.length > 0) return path.join(roots[0], '.agents');
  return path.join(process.cwd(), '.agents');
}

// Default exec: shells to the Commandr bus tool `annotate-write` (or
// ANNOTATE_WRITE_CMD when set, mirroring COUNCIL_EVALUATOR_CMD's testability seam).
export function makeDefaultAnnotateExec({
  roots = [],
  env = process.env,
  bin = env.ANNOTATE_WRITE_CMD || 'annotate-write',
  execFileFn = execFile,
} = {}) {
  return async ({ task, turn, anchor, author, body }) => {
    const bus = resolveBus(roots, env);
    const args = [
      '--bus', bus,
      '--task', String(task),
      '--turn', String(turn),
      '--anchor', String(anchor ?? 'general'),
      '--author', String(author ?? 'human'),
      '--body', String(body ?? ''),
    ];
    await new Promise((resolve, reject) => {
      execFileFn(bin, args, (err) => (err ? reject(err) : resolve()));
    });
  };
}

// Returns a Hono handler; exec({ task, turn, anchor, author, body }) is injectable for tests.
export function makeAnnotateHandler(exec = makeDefaultAnnotateExec()) {
  return async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid body' }, 400); }
    const { task, turn, anchor, author, bodyText } = body ?? {};
    if (typeof task !== 'string' || !task.trim()) return c.json({ error: 'task required' }, 400);
    if (typeof turn !== 'number' || !Number.isFinite(turn)) return c.json({ error: 'turn required' }, 400);
    try {
      await exec({
        task: task.trim(),
        turn,
        anchor: typeof anchor === 'string' && anchor ? anchor : 'general',
        author: typeof author === 'string' && author ? author : 'human',
        body: typeof bodyText === 'string' ? bodyText : '',
      });
    } catch {
      return c.json({ error: 'exec failed' }, 500);
    }
    return c.body(null, 200);
  };
}
