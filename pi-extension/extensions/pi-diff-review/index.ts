import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyReview, formatReviewMessage, readSnapshot, writeDecisionArtifacts, writeStatusArtifact, type ApplyResult } from "./apply-decisions.js";
import { buildDiffRows, changedRows, type FileSnapshot } from "./diff.js";
import { reviewRowsWithUi } from "./review-ui.js";

interface PendingReview {
	toolName: string;
	path: string;
	before: FileSnapshot;
}

function asPath(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const value = (input as { path?: unknown; file_path?: unknown }).path ?? (input as { file_path?: unknown }).file_path;
	return typeof value === "string" && value.trim() ? value : undefined;
}

function appendReviewContent(event: any, result: ApplyResult) {
	const original = Array.isArray(event.content) ? event.content : [];
	return {
		content: [...original, { type: "text", text: formatReviewMessage(result) }],
		details: { ...(event.details ?? {}), piDiffReview: result },
	};
}

export default function piDiffReviewExtension(pi: ExtensionAPI) {
	let enabled = true;
	const pending = new Map<string, PendingReview>();
	const lastDecision = new Map<string, string>();

	pi.registerCommand("diff-review-toggle", {
		description: "Toggle interactive Pi diff review for write/edit tool changes",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.setStatus("pi-diff-review", enabled ? ctx.ui.theme.fg("accent", "diff-review:on") : undefined);
			ctx.ui.notify(`pi-diff-review ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("diff-review-artifacts", {
		description: "Show where Pi diff review writes worker decision artifacts",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Pi diff review artifacts: .pi/diff-review/latest.md and .pi/diff-review/decisions.jsonl", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI && enabled) ctx.ui.setStatus("pi-diff-review", ctx.ui.theme.fg("accent", "diff-review:on"));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (lastDecision.size > 0) {
			try {
				await writeStatusArtifact(ctx.cwd, lastDecision);
			} catch { /* non-fatal */ }
		}
		pending.clear();
		lastDecision.clear();
	});

	pi.on("session_compacted", async () => {
		pending.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		const path = asPath(event.input);
		if (!path) return undefined;

		try {
			pending.set(event.toolCallId, { toolName: event.toolName, path, before: await readSnapshot(ctx.cwd, path) });
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`pi-diff-review could not snapshot ${path}: ${String(error)}`, "warning");
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return undefined;
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		if (event.isError) return undefined;

		const pendingReview = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!pendingReview) return undefined;

		const after = await readSnapshot(ctx.cwd, pendingReview.path);
		if (pendingReview.before.content === after.content && pendingReview.before.existed === after.existed) return undefined;

		const rows = buildDiffRows(pendingReview.before.content, after.content);
		if (changedRows(rows).length === 0) return undefined;

		let result: ApplyResult;
		if (!ctx.hasUI) {
			result = await applyReview(pendingReview.before, after, rows);
			lastDecision.set(result.path, result.action);
			try {
				await writeDecisionArtifacts(ctx.cwd, result, rows, pendingReview.toolName);
			} catch { /* non-fatal */ }
			return result.action === "accepted" ? undefined : appendReviewContent(event, result);
		}

		ctx.ui.setWorkingMessage(`Reviewing ${pendingReview.path}`);
		const reviewedRows = await reviewRowsWithUi(ctx, pendingReview.path, rows);
		ctx.ui.setWorkingMessage();

		if (reviewedRows === "deny-file") {
			for (const row of changedRows(rows)) row.decision = "deny";
			result = await applyReview(pendingReview.before, after, rows);
		} else {
			result = await applyReview(pendingReview.before, after, reviewedRows);
		}
		lastDecision.set(result.path, result.action);

		try {
			await writeDecisionArtifacts(ctx.cwd, result, reviewedRows === "deny-file" ? rows : reviewedRows, pendingReview.toolName);
		} catch { /* non-fatal */ }
		ctx.ui.notify(formatReviewMessage(result), result.action === "accepted" ? "info" : "warning");
		return appendReviewContent(event, result);
	});
}
