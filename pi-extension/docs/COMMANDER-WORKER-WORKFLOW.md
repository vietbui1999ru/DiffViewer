# Commander / Pi Worker Workflow

## Roles

- **Commander / orchestrator:** OpenCode or Claude.
  - OpenCode can use Codex/GPT models.
  - Claude can use Anthropic Claude models.
- **Workers / subagents:** Pi agents.
  - Pi worker model selection is handled by the Pi/OpenCode Go subscription setup outside this extension.
- **Review gate:** `pi-diff-review` extension.
  - Captures worker file edits.
  - Lets the human Accept/Edit/Deny changed lines.
  - Writes decision artifacts for the commander.

## Flow

```text
1. Commander assigns work to Pi worker.
2. Pi worker calls write/edit.
3. pi-diff-review snapshots before content, lets tool execute, snapshots after content.
4. Human reviews changed lines in Pi TUI.
5. Extension applies accepted/edited/restored content to disk.
6. Extension appends .pi/diff-review/decisions.jsonl.
7. Commander reads artifacts and decides next prompt/worker assignment.
```

## Artifact contract

`decisions.jsonl` records are append-only JSON objects:

```json
{
  "ts": "2026-05-29T00:00:00.000Z",
  "toolName": "edit",
  "path": "src/file.ts",
  "action": "partially-applied",
  "summary": {
    "accepted": 3,
    "denied": 1,
    "edited": 1,
    "added": 4,
    "removed": 1,
    "changedRows": 5
  },
  "decisions": [
    { "kind": "added", "newLine": 12, "decision": "accept", "edited": false }
  ]
}
```

Commander prompts can ask Pi workers to include `.pi/diff-review/latest.md` in their handoff summary, or can read `.pi/diff-review/decisions.jsonl` directly from the shared filesystem.

## Non-goals

This extension does not choose models, spawn workers, or route tasks. OpenCode/Claude remains the orchestrator.
