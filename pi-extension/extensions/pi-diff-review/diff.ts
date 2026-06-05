import { diffLines } from "diff";

export type DiffRowKind = "equal" | "added" | "removed";
export type LineDecision = "accept" | "deny" | "edit";

export interface DiffRow {
	id: string;
	kind: DiffRowKind;
	oldLine?: number;
	newLine?: number;
	text: string;
	decision: LineDecision;
	editedText?: string;
}

export interface FileSnapshot {
	path: string;
	absolutePath: string;
	existed: boolean;
	content: string;
}

export interface ReviewSummary {
	accepted: number;
	denied: number;
	edited: number;
	added: number;
	removed: number;
	changedRows: number;
}

export function buildDiffRows(oldText: string, newText: string): DiffRow[] {
	const hunks = diffLines(oldText, newText);
	const rows: DiffRow[] = [];
	let seq = 0;
	let oldLine = 1;
	let newLine = 1;

	for (const hunk of hunks) {
		const lines = hunk.value.replace(/\n$/, "").split("\n");
		for (const text of lines) {
			if (hunk.added) {
				rows.push({ id: String(seq++), kind: "added", newLine: newLine++, text, decision: "accept" });
			} else if (hunk.removed) {
				rows.push({ id: String(seq++), kind: "removed", oldLine: oldLine++, text, decision: "accept" });
			} else {
				rows.push({ id: String(seq++), kind: "equal", oldLine: oldLine++, newLine: newLine++, text, decision: "accept" });
			}
		}
	}

	return rows;
}

export function changedRows(rows: DiffRow[]): DiffRow[] {
	return rows.filter((row) => row.kind !== "equal");
}

export function summarizeRows(rows: DiffRow[]): ReviewSummary {
	const changed = changedRows(rows);
	return {
		accepted: changed.filter((row) => row.decision === "accept").length,
		denied: changed.filter((row) => row.decision === "deny").length,
		edited: changed.filter((row) => row.decision === "edit").length,
		added: changed.filter((row) => row.kind === "added").length,
		removed: changed.filter((row) => row.kind === "removed").length,
		changedRows: changed.length,
	};
}

export function applyLineDecisions(rows: DiffRow[], newText: string): string {
	const newSplit = splitText(newText);
	const output: string[] = [];

	for (const row of rows) {
		if (row.kind === "equal") {
			output.push(row.text);
			continue;
		}

		if (row.kind === "added") {
			if (row.decision === "accept") output.push(row.text);
			else if (row.decision === "edit") output.push(row.editedText ?? row.text);
			// deny added line => omit it
			continue;
		}

		if (row.kind === "removed") {
			if (row.decision === "deny") output.push(row.text);
			else if (row.decision === "edit") output.push(row.editedText ?? row.text);
			// accept removed line => keep deletion, omit old line
		}
	}

	if (output.length === 0) return "";
	return output.join("\n") + (newSplit.trailingNewline ? "\n" : "");
}

export function makeDecisionMarkdown(path: string, summary: ReviewSummary): string {
	return [
		`# Pi Diff Review`,
		``,
		`File: \`${path}\``,
		``,
		`- changed rows: ${summary.changedRows}`,
		`- added rows: ${summary.added}`,
		`- removed rows: ${summary.removed}`,
		`- accepted: ${summary.accepted}`,
		`- denied/restored: ${summary.denied}`,
		`- edited by user: ${summary.edited}`,
		``,
	].join("\n");
}
