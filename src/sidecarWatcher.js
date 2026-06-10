import fs from 'node:fs';
import path from 'node:path';
import { normalizeEvent as defaultNormalizeEvent } from './normalizer.js';

const TURN_FILE_RE = /^turn-\d+\.json$/;

function extractN(basename) {
  const m = basename.match(/^turn-(\d+)\.json$/);
  return m ? parseInt(m[1], 10) : null;
}

// Ingest a single turn-N.json file: parse, validate, normalize, flush, broadcast, unlink.
// Returns true on success, false on any error (leaves file in place on error).
function ingestFile(filePath, { registry, broadcaster, normalizeEvent }) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`[sidecarWatcher] read error ${filePath}: ${err.message}\n`);
    return false;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[sidecarWatcher] parse error ${filePath}: ${err.message}\n`);
    return false;
  }

  // Validate version and required fields
  if (parsed.version !== 1) {
    process.stderr.write(`[sidecarWatcher] unsupported version ${parsed.version} in ${filePath}\n`);
    return false;
  }
  if (
    typeof parsed.sessionId !== 'string' ||
    !parsed.sessionId ||
    !Array.isArray(parsed.events)
  ) {
    process.stderr.write(`[sidecarWatcher] missing required fields in ${filePath}\n`);
    return false;
  }

  // Validate sessionId matches the directory name (spec §1: "same as directory name").
  // The directory layout is <turnsDir>/<sessionId>/turn-N.json, so dirname of the file
  // is the session directory and its basename is the ground truth.
  const expectedSessionId = path.basename(path.dirname(filePath));
  if (parsed.sessionId !== expectedSessionId) {
    process.stderr.write(
      `[sidecarWatcher] sessionId mismatch in ${filePath}: ` +
      `expected '${expectedSessionId}', got '${parsed.sessionId}'\n`
    );
    return false;
  }

  const { sessionId, events } = parsed;

  // Feed each event through the normalizer into the registry
  for (const ev of events) {
    if (!ev || typeof ev.tool !== 'string' || typeof ev.path !== 'string') {
      process.stderr.write(`[sidecarWatcher] invalid event in ${filePath}\n`);
      continue;
    }
    const normalized = normalizeEvent({
      tool: ev.tool,
      path: ev.path,
      oldContent: ev.oldContent ?? '',
      newContent: ev.newContent ?? '',
    });
    registry.add(sessionId, normalized);
  }

  const snapshot = registry.flush(sessionId);
  if (snapshot) {
    broadcaster.emit(snapshot);
    // Unlink only after a successful broadcast (spec §4: "After a successful broadcast the server unlinks").
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      process.stderr.write(`[sidecarWatcher] unlink error ${filePath}: ${err.message}\n`);
    }
  }

  return snapshot !== null;
}

// Startup scan: ingest all pre-existing turn-N.json in a session dir, in ascending N order
function startupScan(sessionDir, deps) {
  let entries;
  try {
    entries = fs.readdirSync(sessionDir);
  } catch {
    return; // directory doesn't exist yet
  }

  const turnFiles = entries
    .filter(name => TURN_FILE_RE.test(name))
    .sort((a, b) => extractN(a) - extractN(b));

  for (const name of turnFiles) {
    ingestFile(path.join(sessionDir, name), deps);
  }
}

/**
 * createSidecarWatcher(roots, { registry, broadcaster, normalizeEvent? })
 *
 * For each root, watches <root>/.diffviewer/turns/ recursively using fs.watch.
 * On startup, scans all pre-existing session dirs for turn-N.json (ordered by N).
 * On each new turn-N.json: normalize events, feed registry, flush, broadcast, unlink.
 * Non-matching files (dotfiles, tmp, etc.) are ignored.
 * Parse/validation errors: log to stderr, leave file, continue.
 *
 * Returns a watcher handle with .close() method.
 */
export function createSidecarWatcher(roots, deps = {}) {
  const effectiveDeps = {
    registry: deps.registry,
    broadcaster: deps.broadcaster,
    normalizeEvent: deps.normalizeEvent ?? defaultNormalizeEvent,
  };

  const fswatchers = [];

  for (const root of roots) {
    const turnsDir = path.join(root, '.diffviewer', 'turns');

    // Create turns dir lazily if absent
    try {
      fs.mkdirSync(turnsDir, { recursive: true });
    } catch (err) {
      process.stderr.write(`[sidecarWatcher] mkdir error ${turnsDir}: ${err.message}\n`);
    }

    // Startup scan: ingest pre-existing turns across all session dirs, ordered by N
    try {
      const sessions = fs.readdirSync(turnsDir);
      for (const sessionId of sessions) {
        const sessionDir = path.join(turnsDir, sessionId);
        try {
          if (fs.statSync(sessionDir).isDirectory()) {
            startupScan(sessionDir, effectiveDeps);
          }
        } catch {}
      }
    } catch {}

    // Single recursive watcher on turnsDir: picks up new session dirs and new turn files
    try {
      const watcher = fs.watch(turnsDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // filename is relative to turnsDir, e.g. "sess-abc/turn-1.json" or "sess-abc"
        const basename = path.basename(filename);
        if (!TURN_FILE_RE.test(basename)) return;

        const filePath = path.join(turnsDir, filename);

        // Small defer to ensure rename(2) has landed before we read
        setImmediate(() => {
          try {
            if (!fs.existsSync(filePath)) return; // already consumed or transient
            ingestFile(filePath, effectiveDeps);
          } catch (err) {
            process.stderr.write(`[sidecarWatcher] handler error: ${err.message}\n`);
          }
        });
      });
      fswatchers.push(watcher);
    } catch (err) {
      process.stderr.write(`[sidecarWatcher] watch error ${turnsDir}: ${err.message}\n`);
    }
  }

  return {
    close() {
      for (const w of fswatchers) {
        try { w.close(); } catch {}
      }
    },
  };
}

// Named re-exports for unit testing internals
export { ingestFile, startupScan };
