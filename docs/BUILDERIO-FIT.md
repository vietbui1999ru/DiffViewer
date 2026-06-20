# Builder.io Fit for DiffViewer

Status: design guidance / backlog input.
Date: 2026-06-19.
Source context: Builder.io Agent-Native, Builder.io Skills, `docs/V0.7-CONTROL-PLANE-COCKPIT-PLAN.md`, and Commandr `protocol/SPEC.md` v0.3.

## Decision

Builder.io's design fits DiffViewer strongly, but only at the UI/action/artifact layer.

Use it for:

- A shared action dispatcher for human clicks and agent proposals.
- Visual plan and visual recap artifacts.
- Review packages that combine diffs, bus events, approvals, tests, screenshots, LSP evidence, and council verdicts.
- Future Tauri cockpit UX where agents and humans collaborate through the same validated actions.

Do not use it for:

- Replacing Commandr `.agents/` lifecycle state.
- Letting DiffViewer become the source of truth for task status or approvals.
- Writing non-SPEC Commandr events such as `artifact_created` or `approval_requested`.
- Storing raw runner transcripts or LSP caches on the bus.

DiffViewer should become Agent-Native in interaction style, not in storage authority.

## Product Fit

| Builder.io idea | DiffViewer use |
|---|---|
| One action powers UI and agent | Every cockpit operation gets a local action schema and risk policy. |
| Context-aware agent operations | Current card, selected file, selected hunk, task id, and approval state become proposal context. |
| Rich visual artifacts | Visual plans and recaps become task-level review packages. |
| App-backed skills | Skills can generate artifacts that DiffViewer renders. |
| Shared state | Tauri/SQLite cache mirrors bus + artifacts, but remains derived. |

## Action Dispatcher

DiffViewer should route UI clicks and agent proposals through the same dispatcher.

```ts
type CockpitAction = {
  name: string;
  schema: unknown;
  actor: "human" | "agent" | "system";
  risk: "low" | "medium" | "high";
  requiresApproval: boolean;
  handler: "commandr" | "diffviewer" | "runner";
  auditEvent: "local" | "commandr" | "none";
};
```

Initial action table:

| Action | Handler | Authority |
|---|---|---|
| `task.progress` | Commandr `bin/progress` | Commandr bus |
| `annotation.create` | Commandr `bin/annotate-write` | Commandr bus |
| `approval.approve` | write `.agents/approvals/<task>.approved` | Commandr bus |
| `approval.deny` | no token write; local audit only | Commandr semantics |
| `review.generatePlan` | DiffViewer artifact writer | local projection |
| `review.generateRecap` | DiffViewer artifact writer | local projection |
| `evidence.pin` | DiffViewer artifact/local audit | local projection |
| `runner.start` | runner adapter | adapter owns process |
| `steer.send` | OpenCode API or clipboard fallback | runner/session control |

Rule: agent text becomes an action proposal, then validation decides whether it can run. Free-form text never directly mutates files, bus state, or runner state.

## Artifact Contract

Builder.io visual plans and recaps map to DiffViewer-owned artifacts.

Recommended local path:

```text
.diffviewer/artifacts/<task-id>/
  plan.md
  review-package.json
  review-package.md
  screenshots/
  lsp-summary.json
  command-log-summary.json
```

Properties:

- Regenerable from bus files, sidecars, git diff, runner artifacts, and local cache.
- Ignored by git by default.
- Not authoritative for lifecycle.
- Safe to delete without losing task truth.
- Can be linked from `task_progress` as a neutral note, but no Commandr artifact event exists yet.

## Visual Plan

Generate before implementation when a task is complex enough to need approval.

Inputs:

| Source | Data |
|---|---|
| Commandr packet | goal, acceptance criteria, files to touch, non-goals |
| llm-wiki/qmd | known patterns, decisions, docs |
| CodeBoarding/CGC | architecture map and blast radius |
| Current UI context | selected file, hunk, card, annotation |

Required output sections:

| Section | Purpose |
|---|---|
| Scope | what will change |
| File map | likely files and why |
| Plan steps | implementation order |
| Risk table | risky actions and mitigations |
| Verification gates | tests, typecheck, visual, screenshot, council, approval |
| Open questions | blockers only |

## Visual Recap / Review Package

Generate after a task reaches review or done.

Inputs:

| Source | Data |
|---|---|
| Git diff | changed files, stats, hunks |
| `.agents/events.jsonl` | progress, annotations, completion |
| `.agents/council/<task>.json` | verdict and vote reasons |
| `.agents/approvals/<task>.approved` | approval state |
| `.diffviewer/turns/` | per-turn sidecars |
| Runner artifacts | logs, screenshots, diagnostics |
| Architecture/LSP evidence | symbols, imports, diagnostics |

Minimal JSON shape:

```json
{
  "task": "TASK-001",
  "summary": "One sentence outcome.",
  "changedFiles": [{ "path": "src/auth.ts", "kind": "edit", "risk": "medium" }],
  "verification": [{ "name": "tests", "status": "pass", "evidence": "npm test" }],
  "approvals": { "approved": false, "tokenPath": ".agents/approvals/TASK-001.approved" },
  "council": { "verdict": "PASS", "abstentions": 0 },
  "artifacts": [{ "type": "screenshot", "path": "screenshots/login.png" }],
  "residualRisks": ["Manual staging deploy not run"]
}
```

UI cards should render: overview, file map, risk, verification, screenshots, logs, approvals, council, residual risks.

## Implementation Order

1. Add review package generation from existing data only.
2. Render the generated package as a card in the current browser UI.
3. Add a local action registry around existing endpoints and handlers.
4. Route agent proposals through the action registry.
5. Move the stabilized action/artifact model into Tauri later.

No Commandr SPEC change is needed for steps 1-4.

## Fit Verdict

Builder.io is a strong fit for DiffViewer's next phase because DiffViewer's job is exactly the thing Builder.io optimizes for: rich human/agent collaboration over structured actions and reviewable artifacts.

The adoption boundary is clear: DiffViewer can become the Agent-Native-style cockpit, while Commandr remains the lifecycle bus.

## Related Docs

- `docs/V0.7-CONTROL-PLANE-COCKPIT-PLAN.md` - current cockpit backlog.
- `../../Commandr/docs/BUILDERIO-FIT.md` - L3 bus boundary and promotion rules.
- `~/repos/llm-wiki/wiki/syntheses/builderio-control-plane-integration.md` - broader synthesis.
