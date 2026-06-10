# DiffViewer — OpenCode plugin

Captures file-write events from OpenCode sessions and writes them as sidecar
snapshot files under `<repo>/.diffviewer/turns/` per the v0.6 spec. The
DiffViewer server ingests these files and streams turn diffs to the browser.

## Install

Symlink into your OpenCode plugins directory:

```sh
ln -s /path/to/DiffViewer/adapters/opencode/diffviewer.js \
      ~/.config/opencode/plugins/diffviewer.js
```

OpenCode also discovers plugins in `.opencode/plugins/` in the project root.

## How it works

- `tool.execute.before` (write/edit tools): reads pre-write disk content.
- `tool.execute.after`: reads post-write disk content, queues `{tool, path, oldContent, newContent}`.
- `session.status` idle (+ deprecated `session.idle` twin, behind an in-flight guard):
  flushes the pending list to `<repo>/.diffviewer/turns/<sessionId>/turn-<N>.json`
  using the tmp-then-rename atomic write protocol.

Empty turns (no file writes) produce no file.

## Add to gitignore

```sh
echo '.diffviewer/' >> <repo>/.gitignore
```
