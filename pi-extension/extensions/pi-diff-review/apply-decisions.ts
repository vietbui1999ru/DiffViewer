import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { applyLineDecisions, makeDecisionMarkdown, summarizeRows, type DiffRow, type FileSnapshot } from "./diff.js";

export interface ApplyResult {
	path: string;
	action: "accepted" | "restored" | "partially-applied" | "deleted-new-file";
	summary: ReturnType<typeof summarizeRows>;
	finalContent?: string;
}

export function resolveToolPath(cwd: string, rawPath: string): string {
	const path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return isAbsolute(path) ? path : resolve(cwd, path);
}

export async function readSnapshot(cwd: string, rawPath: string): Promise<FileSnapshot> {
	const absolutePath = resolveToolPath(cwd, rawPath);
	try {
		return { path: rawPath, absolutePath, existed: true, content: await readFile(absolutePath, "utf8") };
	} catch (error) {
		const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined;
		if (code === "ENOENT") return { path: rawPath, absolutePath, existed: false, content: "" };
		throw error;
	}
}

export async function applyReview(oldSnapshot: FileSnapshot, newSnapshot: FileSnapshot, rows: DiffRow[]): Promise<ApplyResult> {
	const summary = summarizeRows(rows);
	const finalContent = applyLineDecisions(rows, newSnapshot.content);

	if (summary.denied === 0 && summary.edited === 0) {
		return { path: newSnapshot.path, action: "accepted", summary };
	}

	if (!oldSnapshot.existed && finalContent.length === 0) {
		await rm(newSnapshot.absolutePath, { force: true });
		return { path: newSnapshot.path, action: "deleted-new-file", summary, finalContent };
	}

	await mkdir(dirname(newSnapshot.absolutePath), { recursive: true });
	await writeFile(newSnapshot.absolutePath, finalContent, "utf8");
	return {
		path: newSnapshot.path,
		action: summary.accepted === 0 && summary.edited === 0 ? "restored" : "partially-applied",
		summary,
		finalContent,
	};
}

export async function writeDecisionArtifacts(cwd: string, result: ApplyResult, rows: DiffRow[], toolName: string): Promise<void> {
	const dir = resolve(cwd, ".pi", "diff-review");
	await mkdir(dir, { recursive: true });
	const record = {
		ts: new Date().toISOString(),
		toolName,
		path: result.path,
		action: result.action,
		summary: result.summary,
		decisions: rows
			.filter((row) => row.kind !== "equal")
			.map((row) => ({
				kind: row.kind,
				oldLine: row.oldLine,
				newLine: row.newLine,
				decision: row.decision,
				edited: row.decision === "edit",
			})),
	};
	await writeFile(resolve(dir, "latest.md"), makeDecisionMarkdown(result.path, result.summary), "utf8");
	await writeFile(resolve(dir, "decisions.jsonl"), `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

export const MAX_RETRIES = 3;

export interface StatusArtifact {
	resolved: boolean;
	unresolvedFiles: string[];
	retryCount: number;
	needsHuman: boolean;
}

export async function writeStatusArtifact(cwd: string, lastDecision: Map<string, string>): Promise<void> {
	const unresolvedFiles = [...lastDecision.entries()]
		.filter(([, action]) => action !== "accepted")
		.map(([path]) => path);
	const retryCount = Number(process.env["DIFF_REVIEW_RETRY_COUNT"] ?? "0");
	const resolved = unresolvedFiles.length === 0;
	const artifact: StatusArtifact = {
		resolved,
		unresolvedFiles,
		retryCount,
		needsHuman: !resolved && retryCount >= MAX_RETRIES - 1,
	};
	const taskId = process.env["PUEUE_TASK_ID"];
	const filename = taskId ? `status-${taskId}.json` : "status.json";
	const dir = resolve(cwd, ".pi", "diff-review");
	await mkdir(dir, { recursive: true });
	await writeFile(resolve(dir, filename), JSON.stringify(artifact, null, 2), "utf8");
}

export function formatReviewMessage(result: ApplyResult): string {
	const s = result.summary;
	return [
		`pi-diff-review: ${result.action} ${result.path}`,
		`changed rows=${s.changedRows}, accepted=${s.accepted}, denied/restored=${s.denied}, edited=${s.edited}`,
		`decision artifacts: .pi/diff-review/latest.md and .pi/diff-review/decisions.jsonl`,
	].join("\n");
}
