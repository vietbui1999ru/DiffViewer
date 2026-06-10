// diffviewer.js — OpenCode plugin: captures file-write events per turn and
// flushes them as sidecar snapshot files per the DiffViewer v0.6 spec §1-3.
//
// Transport only. On tool.execute.before/after pairs for write/edit tools:
// capture {path, oldContent, newContent} into a per-sessionID pending list.
// On session.status idle (or deprecated session.idle twin), flush pending to
// <repo>/.diffviewer/turns/<sanitized-sessionID>/turn-<N>.json using the
// tmp-then-rename atomic write protocol from spec §2.
//
// Convention: mirrors Commandr's checkpoint.js — ESM default export, same
// isTurnEnd helper, same in-flight guard pattern to block the deprecated
// session.idle twin from firing a double write.
//
// Install:
//   ln -s /path/to/DiffViewer/adapters/opencode/diffviewer.js \
//         ~/.config/opencode/plugins/diffviewer.js

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

// Tools whose writes we capture. OC uses lowercase names.
const WRITE_TOOLS = new Set(['write', 'edit'])

// Same idle-detection logic as Commandr checkpoint.js.
const isTurnEnd = (event) =>
  (event?.type === 'session.status' &&
    event?.properties?.status?.type === 'idle') ||
  event?.type === 'session.idle'

// Sanitize a sessionID to [A-Za-z0-9._-], max 128 chars (spec §1).
function sanitizeSessionId(id) {
  return String(id)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 128)
}

// Read file content fail-silently (returns '' on any error).
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

// Resolve repo root from a directory via git rev-parse, fail-silently.
function resolveRepoRoot(cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd },
      (err, stdout) => {
        resolve(err ? null : stdout.trim())
      }
    )
  })
}

// Compute next turn number by scanning existing turn-*.json files.
function nextTurnNumber(sessionDir) {
  if (!fs.existsSync(sessionDir)) return 1
  const files = fs.readdirSync(sessionDir).filter(f => /^turn-\d+\.json$/.test(f))
  if (!files.length) return 1
  const max = Math.max(...files.map(f => parseInt(f.match(/\d+/)[0], 10)))
  return max + 1
}

// Write the snapshot using the tmp-then-rename protocol (spec §2).
function writeTurnFile(sessionDir, n, payload) {
  fs.mkdirSync(sessionDir, { recursive: true })
  const tmp = path.join(sessionDir, `.tmp-turn-${n}.json`)
  const final = path.join(sessionDir, `turn-${n}.json`)
  fs.writeFileSync(tmp, JSON.stringify(payload))
  fs.renameSync(tmp, final)
}

export const DiffViewerPlugin = async ({ directory, worktree }) => {
  const pluginDir = directory || worktree || process.cwd()

  // Map<sessionID, {pending: Array, startedAt: number}>
  const sessions = new Map()

  // Map<"sessionID:callID", {sessionID, tool, filePath, oldContent}> — tracks in-flight tool calls.
  // Keyed by composite sessionID:callID to prevent cross-session collisions when OC reuses
  // short callIDs (e.g. incrementing integers). A stale entry from a crashed session can
  // never be picked up by a new session with the same callID.
  const inFlight = new Map()

  // Per-session in-flight guard (mirrors checkpoint.js pattern).
  const flushGuards = new Map()

  // Pruning: at plugin init, remove .diffviewer/turns/ session dirs with no activity for >7 days.
  // Best-effort, fail-silent (spec §5).
  try {
    const root = await resolveRepoRoot(pluginDir)
    if (root) {
      const turnsDir = path.join(root, '.diffviewer', 'turns')
      if (fs.existsSync(turnsDir)) {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
        for (const entry of fs.readdirSync(turnsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const dirPath = path.join(turnsDir, entry.name)
          try {
            const stat = fs.statSync(dirPath)
            if (stat.mtimeMs < sevenDaysAgo) {
              fs.rmSync(dirPath, { recursive: true, force: true })
            }
          } catch {
            // ignore per-entry errors
          }
        }
      }
    }
  } catch {
    // fail-silent
  }

  const getOrCreateSession = (sessionID) => {
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, { pending: [], startedAt: null })
    }
    return sessions.get(sessionID)
  }

  async function flushSession(sessionID) {
    const sess = sessions.get(sessionID)
    if (!sess?.pending?.length) return

    const root = await resolveRepoRoot(pluginDir)
    if (!root) return // fail-silent if not in a git repo

    const sanitized = sanitizeSessionId(sessionID)
    const sessionDir = path.join(root, '.diffviewer', 'turns', sanitized)
    const n = nextTurnNumber(sessionDir)

    const now = Date.now()
    const payload = {
      version: 1,
      sessionId: sanitized,
      harness: 'opencode',
      task: null,
      turnNumber: n,
      startedAt: sess.startedAt ?? now,
      completedAt: now,
      events: sess.pending.slice(),
    }

    try {
      writeTurnFile(sessionDir, n, payload)
    } catch (err) {
      console.error(`diffviewer: flush failed for session ${sessionID}: ${err}`)
    }

    sessions.delete(sessionID)
  }

  return {
    'tool.execute.before': async ({ tool, sessionID, callID }, { args }) => {
      if (!WRITE_TOOLS.has(tool)) return

      const filePath = args?.filePath ?? args?.file_path
      if (!filePath) return

      const oldContent = readFileSafe(filePath)
      inFlight.set(`${sessionID}:${callID}`, { sessionID, tool, filePath, oldContent })
    },

    'tool.execute.after': async ({ tool, sessionID, callID }, _output) => {
      const pending = inFlight.get(`${sessionID}:${callID}`)
      if (!pending) return
      inFlight.delete(`${sessionID}:${callID}`)

      const filePath = pending.filePath
      const newContent = readFileSafe(filePath)

      const sess = getOrCreateSession(sessionID)
      if (sess.startedAt === null) sess.startedAt = Date.now()

      sess.pending.push({
        tool: pending.tool,
        path: filePath,
        oldContent: pending.oldContent,
        newContent,
      })
    },

    event: async ({ event }) => {
      if (!isTurnEnd(event)) return

      // In-flight guard: process all pending sessions, one flush per idle pair.
      // Guard prevents concurrent double-flush within a single event-loop tick
      // (e.g., Promise.all). Sequential double-idle is prevented by sessions.delete()
      // in flushSession.
      const sessionIDs = [...sessions.keys()]

      for (const sessionID of sessionIDs) {
        if (flushGuards.get(sessionID)) continue
        flushGuards.set(sessionID, true)
        try {
          await flushSession(sessionID)
        } finally {
          flushGuards.delete(sessionID)
        }
      }
    },
  }
}

export default DiffViewerPlugin
