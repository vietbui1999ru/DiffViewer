/**
 * Tests for adapters/opencode/diffviewer.js
 *
 * The plugin is a plain function module — no OpenCode process needed.
 * We import it, call it with stubbed {client, $} context, invoke the
 * returned hooks directly with synthetic inputs, and assert on disk state
 * in a real tmp git repo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import DiffViewerPlugin from '../adapters/opencode/diffviewer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a tmp directory initialised as a git repo.
 * Returns { root, cleanup }.
 */
function makeTmpGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-plugin-test-'))
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' })
  // Initial commit so HEAD is valid
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: root, stdio: 'ignore' })
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

/**
 * Instantiate the plugin with a stubbed PluginInput.
 * directory drives git rev-parse for the repo root.
 */
async function makePlugin(directory) {
  const hooks = await DiffViewerPlugin({ client: {}, $: null, directory, worktree: directory })
  return hooks
}

/**
 * Fire the idle event (both the canonical and deprecated shape) as checkpoint.js does.
 */
async function fireIdle(hooks, sessionID) {
  await hooks.event?.({ event: { type: 'session.status', properties: { status: { type: 'idle' } } } })
  // deprecated twin — in-flight guard should block this
  await hooks.event?.({ event: { type: 'session.idle' } })
}

/**
 * Read the written turn file from the session dir.
 * Returns parsed JSON or null if not found.
 */
function readTurnFile(root, sessionId) {
  const sessionDir = path.join(root, '.diffviewer', 'turns', sessionId)
  if (!fs.existsSync(sessionDir)) return null
  const files = fs.readdirSync(sessionDir).filter(f => /^turn-\d+\.json$/.test(f))
  if (!files.length) return null
  // Ascending by N
  files.sort((a, b) => {
    const na = parseInt(a.match(/\d+/)[0], 10)
    const nb = parseInt(b.match(/\d+/)[0], 10)
    return na - nb
  })
  return JSON.parse(fs.readFileSync(path.join(sessionDir, files[0]), 'utf8'))
}

/**
 * List all files in the session dir (including .tmp* files).
 */
function listSessionFiles(root, sessionId) {
  const sessionDir = path.join(root, '.diffviewer', 'turns', sessionId)
  if (!fs.existsSync(sessionDir)) return []
  return fs.readdirSync(sessionDir)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('oc-plugin — tool.execute.before / after pairing', () => {
  let repo, hooks

  beforeEach(async () => {
    repo = makeTmpGitRepo()
    hooks = await makePlugin(repo.root)
  })

  afterEach(() => {
    repo.cleanup()
  })

  it('OP1 before/after pair captures oldContent+newContent and queues event', async () => {
    const filePath = path.join(repo.root, 'hello.js')
    fs.writeFileSync(filePath, 'old content\n')

    // before hook — capture pre-write content
    await hooks['tool.execute.before']?.(
      { tool: 'write', sessionID: 'sess-1', callID: 'call-1' },
      { args: { filePath } }
    )

    // Simulate the actual write
    fs.writeFileSync(filePath, 'new content\n')

    // after hook — capture post-write content
    await hooks['tool.execute.after']?.(
      { tool: 'write', sessionID: 'sess-1', callID: 'call-1', args: { filePath } },
      { title: 'write', output: '', metadata: {} }
    )

    // Flush via idle event
    await fireIdle(hooks, 'sess-1')

    const snap = readTurnFile(repo.root, 'sess-1')
    expect(snap).not.toBeNull()
    expect(snap.events).toHaveLength(1)
    expect(fs.realpathSync(snap.events[0].path)).toBe(fs.realpathSync(filePath))
    expect(snap.events[0].oldContent).toBe('old content\n')
    expect(snap.events[0].newContent).toBe('new content\n')
    expect(snap.events[0].tool).toBe('write')
  })

  it('OP2 edit tool also captured (tool name "edit")', async () => {
    const filePath = path.join(repo.root, 'edit-me.js')
    fs.writeFileSync(filePath, 'before edit\n')

    await hooks['tool.execute.before']?.(
      { tool: 'edit', sessionID: 'sess-2', callID: 'call-2' },
      { args: { filePath } }
    )
    fs.writeFileSync(filePath, 'after edit\n')
    await hooks['tool.execute.after']?.(
      { tool: 'edit', sessionID: 'sess-2', callID: 'call-2', args: { filePath } },
      { title: 'edit', output: '', metadata: {} }
    )
    await fireIdle(hooks, 'sess-2')

    const snap = readTurnFile(repo.root, 'sess-2')
    expect(snap.events[0].tool).toBe('edit')
    expect(snap.events[0].oldContent).toBe('before edit\n')
    expect(snap.events[0].newContent).toBe('after edit\n')
  })

  it('OP3 unknown tools ignored — before/after do not queue event', async () => {
    await hooks['tool.execute.before']?.(
      { tool: 'bash', sessionID: 'sess-3', callID: 'call-3' },
      { args: { command: 'ls' } }
    )
    await hooks['tool.execute.after']?.(
      { tool: 'bash', sessionID: 'sess-3', callID: 'call-3', args: { command: 'ls' } },
      { title: 'bash', output: '', metadata: {} }
    )
    await fireIdle(hooks, 'sess-3')

    const snap = readTurnFile(repo.root, 'sess-3')
    expect(snap).toBeNull() // nothing written
  })

  it('OP4 file absent before write — oldContent is empty string', async () => {
    const filePath = path.join(repo.root, 'brand-new.js')
    // no pre-existing file

    await hooks['tool.execute.before']?.(
      { tool: 'write', sessionID: 'sess-4', callID: 'call-4' },
      { args: { filePath } }
    )
    fs.writeFileSync(filePath, 'created\n')
    await hooks['tool.execute.after']?.(
      { tool: 'write', sessionID: 'sess-4', callID: 'call-4', args: { filePath } },
      { title: 'write', output: '', metadata: {} }
    )
    await fireIdle(hooks, 'sess-4')

    const snap = readTurnFile(repo.root, 'sess-4')
    expect(snap.events[0].oldContent).toBe('')
    expect(snap.events[0].newContent).toBe('created\n')
  })

  it('OP12 apply_patch delete+add overwrite is captured once', async () => {
    const filePath = path.join(repo.root, 'patch-me.txt')
    fs.writeFileSync(filePath, 'before\n')

    await hooks['tool.execute.before']?.(
      { tool: 'apply_patch', sessionID: 'sess-12', callID: 'call-12' },
      { args: { patchText: `*** Begin Patch
*** Delete File: patch-me.txt
*** Add File: patch-me.txt
+after
*** End Patch` } }
    )

    fs.writeFileSync(filePath, 'after\n')

    await hooks['tool.execute.after']?.(
      { tool: 'apply_patch', sessionID: 'sess-12', callID: 'call-12' },
      { title: 'patch', output: '', metadata: {} }
    )
    await fireIdle(hooks, 'sess-12')

    const snap = readTurnFile(repo.root, 'sess-12')
    expect(snap).not.toBeNull()
    expect(snap.events).toHaveLength(1)
    expect(snap.events[0].tool).toBe('apply_patch')
    expect(fs.realpathSync(snap.events[0].path)).toBe(fs.realpathSync(filePath))
    expect(snap.events[0].oldContent).toBe('before\n')
    expect(snap.events[0].newContent).toBe('after\n')
  })
})

describe('oc-plugin — snapshot file shape (spec §1)', () => {
  let repo, hooks

  beforeEach(async () => {
    repo = makeTmpGitRepo()
    hooks = await makePlugin(repo.root)
  })

  afterEach(() => {
    repo.cleanup()
  })

  it('OP5 snapshot has all required spec §1 fields', async () => {
    const filePath = path.join(repo.root, 'shape.js')
    fs.writeFileSync(filePath, 'a\n')

    await hooks['tool.execute.before']?.(
      { tool: 'write', sessionID: 'my-session-id', callID: 'c1' },
      { args: { filePath } }
    )
    fs.writeFileSync(filePath, 'b\n')
    await hooks['tool.execute.after']?.(
      { tool: 'write', sessionID: 'my-session-id', callID: 'c1', args: { filePath } },
      { title: 'write', output: '', metadata: {} }
    )
    await fireIdle(hooks, 'my-session-id')

    const snap = readTurnFile(repo.root, 'my-session-id')
    expect(snap).not.toBeNull()

    // Version and harness
    expect(snap.version).toBe(1)
    expect(snap.harness).toBe('opencode')
    expect(snap.task).toBeNull()

    // Session and turn
    expect(snap.sessionId).toBe('my-session-id')
    expect(snap.turnNumber).toBe(1)

    // Timestamps — epoch ms integers
    expect(typeof snap.startedAt).toBe('number')
    expect(typeof snap.completedAt).toBe('number')
    expect(Number.isInteger(snap.startedAt)).toBe(true)
    expect(Number.isInteger(snap.completedAt)).toBe(true)
    expect(snap.startedAt).toBeGreaterThan(0)
    expect(snap.completedAt).toBeGreaterThanOrEqual(snap.startedAt)

    // Events
    expect(Array.isArray(snap.events)).toBe(true)
    expect(snap.events).toHaveLength(1)
    const ev = snap.events[0]
    expect(ev.tool).toBe('write')
    expect(typeof ev.path).toBe('string')
    expect(typeof ev.oldContent).toBe('string')
    expect(typeof ev.newContent).toBe('string')
  })
})

describe('oc-plugin — write protocol (spec §2)', () => {
  let repo, hooks

  beforeEach(async () => {
    repo = makeTmpGitRepo()
    hooks = await makePlugin(repo.root)
  })

  afterEach(() => {
    repo.cleanup()
  })

  it('OP6 .tmp file not left behind after successful flush', async () => {
    const sessionID = 'protocol-sess'
    const filePath = path.join(repo.root, 'p.js')
    fs.writeFileSync(filePath, 'x\n')

    await hooks['tool.execute.before']?.(
      { tool: 'write', sessionID, callID: 'cx' },
      { args: { filePath } }
    )
    fs.writeFileSync(filePath, 'y\n')
    await hooks['tool.execute.after']?.(
      { tool: 'write', sessionID, callID: 'cx', args: { filePath } },
      { title: 'write', output: '', metadata: {} }
    )
    await fireIdle(hooks, sessionID)

    const files = listSessionFiles(repo.root, sessionID)
    const tmpFiles = files.filter(f => f.startsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)
    expect(files.some(f => /^turn-\d+\.json$/.test(f))).toBe(true)
  })

  it('OP7 turnNumber increments monotonically across flushes', async () => {
    const sessionID = 'mono-sess'
    const f1 = path.join(repo.root, 'f1.js')
    const f2 = path.join(repo.root, 'f2.js')
    fs.writeFileSync(f1, 'a\n')
    fs.writeFileSync(f2, 'c\n')

    // First turn
    await hooks['tool.execute.before']?.({ tool: 'write', sessionID, callID: 'ca' }, { args: { filePath: f1 } })
    fs.writeFileSync(f1, 'b\n')
    await hooks['tool.execute.after']?.({ tool: 'write', sessionID, callID: 'ca', args: { filePath: f1 } }, { title: 'write', output: '', metadata: {} })
    await fireIdle(hooks, sessionID)

    // Second turn — fire a fresh idle pair
    await hooks['tool.execute.before']?.({ tool: 'write', sessionID, callID: 'cb' }, { args: { filePath: f2 } })
    fs.writeFileSync(f2, 'd\n')
    await hooks['tool.execute.after']?.({ tool: 'write', sessionID, callID: 'cb', args: { filePath: f2 } }, { title: 'write', output: '', metadata: {} })
    await fireIdle(hooks, sessionID)

    const sessionDir = path.join(repo.root, '.diffviewer', 'turns', sessionID)
    const turns = fs.readdirSync(sessionDir)
      .filter(f => /^turn-\d+\.json$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))

    expect(turns).toHaveLength(2)
    const t1 = JSON.parse(fs.readFileSync(path.join(sessionDir, turns[0]), 'utf8'))
    const t2 = JSON.parse(fs.readFileSync(path.join(sessionDir, turns[1]), 'utf8'))
    expect(t1.turnNumber).toBe(1)
    expect(t2.turnNumber).toBe(2)
  })
})

describe('oc-plugin — in-flight guard (no double write)', () => {
  let repo, hooks

  beforeEach(async () => {
    repo = makeTmpGitRepo()
    hooks = await makePlugin(repo.root)
  })

  afterEach(() => {
    repo.cleanup()
  })

  it('OP8 session.status + session.idle back-to-back writes only one file', async () => {
    const sessionID = 'guard-sess'
    const filePath = path.join(repo.root, 'g.js')
    fs.writeFileSync(filePath, 'old\n')

    await hooks['tool.execute.before']?.({ tool: 'write', sessionID, callID: 'cg' }, { args: { filePath } })
    fs.writeFileSync(filePath, 'new\n')
    await hooks['tool.execute.after']?.({ tool: 'write', sessionID, callID: 'cg', args: { filePath } }, { title: 'write', output: '', metadata: {} })

    // Fire BOTH idle variants concurrently (simulating back-to-back OpenCode events)
    await Promise.all([
      hooks.event?.({ event: { type: 'session.status', properties: { status: { type: 'idle' } } } }),
      hooks.event?.({ event: { type: 'session.idle' } }),
    ])

    const files = listSessionFiles(repo.root, sessionID).filter(f => /^turn-\d+\.json$/.test(f))
    expect(files).toHaveLength(1)
  })
})

describe('oc-plugin — empty pending writes nothing', () => {
  let repo, hooks

  beforeEach(async () => {
    repo = makeTmpGitRepo()
    hooks = await makePlugin(repo.root)
  })

  afterEach(() => {
    repo.cleanup()
  })

  it('OP9 idle with no pending events does not create any file', async () => {
    await fireIdle(hooks, 'empty-sess')

    const sessionDir = path.join(repo.root, '.diffviewer', 'turns', 'empty-sess')
    // Directory may not even exist, or if it does, must have no turn files
    if (fs.existsSync(sessionDir)) {
      const files = fs.readdirSync(sessionDir).filter(f => /^turn-\d+\.json$/.test(f))
      expect(files).toHaveLength(0)
    } else {
      // Good — nothing created
      expect(true).toBe(true)
    }
  })
})

describe('oc-plugin — sessionID sanitization', () => {
  let repo, hooks

  beforeEach(async () => {
    repo = makeTmpGitRepo()
    hooks = await makePlugin(repo.root)
  })

  afterEach(() => {
    repo.cleanup()
  })

  it('OP10 sessionID with special chars sanitized to [A-Za-z0-9._-] in dir name', async () => {
    const rawSession = 'sess/with:special!chars'
    const expectedSanitized = 'sess_with_special_chars'
    const filePath = path.join(repo.root, 'san.js')
    fs.writeFileSync(filePath, 'a\n')

    await hooks['tool.execute.before']?.({ tool: 'write', sessionID: rawSession, callID: 'cs' }, { args: { filePath } })
    fs.writeFileSync(filePath, 'b\n')
    await hooks['tool.execute.after']?.({ tool: 'write', sessionID: rawSession, callID: 'cs', args: { filePath } }, { title: 'write', output: '', metadata: {} })
    await hooks.event?.({ event: { type: 'session.status', properties: { status: { type: 'idle' } } } })

    // The directory should use the sanitized name
    const sessionDir = path.join(repo.root, '.diffviewer', 'turns', expectedSanitized)
    expect(fs.existsSync(sessionDir)).toBe(true)
    const files = fs.readdirSync(sessionDir).filter(f => /^turn-\d+\.json$/.test(f))
    expect(files).toHaveLength(1)

    // The JSON payload keeps the safe sessionId for the sidecar path and rawSessionId for APIs.
    const snap = JSON.parse(fs.readFileSync(path.join(sessionDir, files[0]), 'utf8'))
    expect(snap.sessionId).toBe(expectedSanitized)
    expect(snap.rawSessionId).toBe(rawSession)
  })
})

describe('oc-plugin — args.file_path fallback', () => {
  let repo, hooks

  beforeEach(async () => {
    repo = makeTmpGitRepo()
    hooks = await makePlugin(repo.root)
  })

  afterEach(() => {
    repo.cleanup()
  })

  it('OP11 args.file_path (snake_case) is accepted when filePath absent', async () => {
    const filePath = path.join(repo.root, 'snake.js')
    fs.writeFileSync(filePath, 'snake\n')

    await hooks['tool.execute.before']?.(
      { tool: 'write', sessionID: 'snake-sess', callID: 'csnk' },
      { args: { file_path: filePath } }  // snake_case variant
    )
    fs.writeFileSync(filePath, 'new snake\n')
    await hooks['tool.execute.after']?.(
      { tool: 'write', sessionID: 'snake-sess', callID: 'csnk', args: { file_path: filePath } },
      { title: 'write', output: '', metadata: {} }
    )
    await fireIdle(hooks, 'snake-sess')

    const snap = readTurnFile(repo.root, 'snake-sess')
    expect(snap).not.toBeNull()
    expect(snap.events[0].path).toBe(filePath)
  })
})
