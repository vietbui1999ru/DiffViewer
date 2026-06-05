# pi-diff-review

Pi package that turns Pi worker agents into review-gated subagents. It intercepts Pi `write` and `edit` tool changes, snapshots the file before the tool runs, computes a line-level diff after the tool succeeds, and asks the human to Accept/Edit/Deny changed lines before the worker continues.

## Intended workflow

```text
OpenCode or Claude commander/orchestrator
  -> launches/prompts Pi worker agents
     -> pi-diff-review gates worker file mutations
        -> decisions are written to .pi/diff-review/ for the commander to inspect
```

The commander stays outside Pi. The extension only controls worker-side file changes and writes artifacts.

## Install for local development

From this repository:

```bash
pi install /Users/vietquocbui/repos/DiffViewer/pi-extension
# or project-local from another repo:
pi install -l /Users/vietquocbui/repos/DiffViewer/pi-extension
```

For a one-off test:

```bash
pi -e /Users/vietquocbui/repos/DiffViewer/pi-extension
```

## Commands

- `/diff-review-toggle` — enable/disable the review gate for the current Pi session.
- `/diff-review-artifacts` — show the artifact paths.

## Review controls

When a `write` or `edit` succeeds:

- `↑` / `↓` — move between changed lines
- `space` or `t` — cycle selected line: accept → deny/restore → edit
- `e` — edit selected line text
- `a` — accept all changed lines
- `d` — deny/restore all changed lines
- `enter` or `q` — apply decisions
- `esc` — restore/deny the whole file

Decision semantics:

- Added line + accept = keep it
- Added line + deny = remove it
- Removed line + accept = keep the deletion
- Removed line + deny = restore the old line
- Edit = replace that line with user-provided text

## Commander artifacts

Each review appends JSONL to:

```text
.pi/diff-review/decisions.jsonl
```

The latest summary is also written to:

```text
.pi/diff-review/latest.md
```

OpenCode/Claude commanders can read these files to understand what the worker actually changed, what was denied, and what the user edited.

## Scope

MVP handles Pi built-in `write` and `edit` tools. It does not yet inspect file mutations caused by `bash` commands or external formatters.
