import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { changedRows, summarizeRows, type DiffRow, type LineDecision } from "./diff.js";

export type ReviewUiResult =
	| { action: "finish"; rows: DiffRow[] }
	| { action: "edit"; rowId: string }
	| { action: "accept-file" }
	| { action: "deny-file" };

interface ReviewComponentOptions {
	path: string;
	rows: DiffRow[];
	done: (value: ReviewUiResult) => void;
	theme: any;
	requestRender: () => void;
}

function nextDecision(current: LineDecision): LineDecision {
	if (current === "accept") return "deny";
	if (current === "deny") return "edit";
	return "accept";
}

function decisionLabel(row: DiffRow): string {
	if (row.decision === "accept") return row.kind === "removed" ? "accept delete" : "accept";
	if (row.decision === "deny") return row.kind === "removed" ? "restore" : "deny";
	return "edit";
}

function lineLabel(row: DiffRow): string {
	const oldPart = row.oldLine === undefined ? "   " : String(row.oldLine).padStart(3, " ");
	const newPart = row.newLine === undefined ? "   " : String(row.newLine).padStart(3, " ");
	const sign = row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ";
	return `${oldPart} ${newPart} ${sign}`;
}

export class DiffReviewComponent implements Component {
	private path: string;
	private rows: DiffRow[];
	private changed: DiffRow[];
	private selected = 0;
	private scroll = 0;
	private done: (value: ReviewUiResult) => void;
	private theme: any;
	private requestRender: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(options: ReviewComponentOptions) {
		this.path = options.path;
		this.rows = options.rows;
		this.changed = changedRows(options.rows);
		this.done = options.done;
		this.theme = options.theme;
		this.requestRender = options.requestRender;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
			this.invalidate();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(this.changed.length - 1, this.selected + 1);
			this.invalidate();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.selected = 0;
			this.invalidate();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.selected = Math.max(0, this.changed.length - 1);
			this.invalidate();
			this.requestRender();
			return;
		}
		if (data === "a") {
			for (const row of this.changed) row.decision = "accept";
			this.invalidate();
			this.requestRender();
			return;
		}
		if (data === "d") {
			for (const row of this.changed) row.decision = "deny";
			this.invalidate();
			this.requestRender();
			return;
		}
		if (data === "t" || matchesKey(data, Key.space)) {
			const row = this.changed[this.selected];
			if (row) row.decision = nextDecision(row.decision);
			this.invalidate();
			this.requestRender();
			return;
		}
		if (data === "e") {
			const row = this.changed[this.selected];
			if (row) this.done({ action: "edit", rowId: row.id });
			return;
		}
		if (matchesKey(data, Key.enter) || data === "q") {
			this.done({ action: "finish", rows: this.rows });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.done({ action: "deny-file" });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const t = this.theme;
		const summary = summarizeRows(this.rows);
		const lines: string[] = [];
		lines.push(t.fg("accent", t.bold("Pi Diff Review")) + " " + t.fg("muted", this.path));
		lines.push(
			t.fg(
				"dim",
				`changed=${summary.changedRows} added=${summary.added} removed=${summary.removed} accept=${summary.accepted} deny=${summary.denied} edit=${summary.edited}`,
			),
		);
		lines.push(t.fg("dim", "↑↓ move • space/t cycle line • e edit line • a accept all • d deny all • enter/q apply • esc restore file"));
		lines.push("");

		const visible = Math.max(5, Math.min(20, this.changed.length));
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1;
		const rows = this.changed.slice(this.scroll, this.scroll + visible);

		for (let i = 0; i < rows.length; i++) {
			const row = rows[i]!;
			const idx = this.scroll + i;
			const isSelected = idx === this.selected;
			const color = row.kind === "added" ? "success" : row.kind === "removed" ? "error" : "text";
			const prefix = isSelected ? t.fg("accent", ">") : " ";
			const decision = row.decision === "accept" ? t.fg("success", decisionLabel(row)) : row.decision === "deny" ? t.fg("error", decisionLabel(row)) : t.fg("warning", decisionLabel(row));
			const text = row.decision === "edit" ? (row.editedText ?? row.text) : row.text;
			const rendered = `${prefix} ${lineLabel(row)} [${decision}] ${t.fg(color, text)}`;
			lines.push(truncateToWidth(rendered, width));
		}

		if (this.changed.length > visible) {
			lines.push(t.fg("dim", `showing ${this.scroll + 1}-${Math.min(this.scroll + visible, this.changed.length)} of ${this.changed.length}`));
		}

		this.cachedWidth = width;
		this.cachedLines = lines.map((line) => truncateToWidth(line, width));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export async function reviewRowsWithUi(ctx: any, path: string, rows: DiffRow[]): Promise<DiffRow[] | "deny-file"> {
	let currentRows = rows;
	while (true) {
		const result = (await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (value: ReviewUiResult) => void) => {
			return new DiffReviewComponent({ path, rows: currentRows, done, theme, requestRender: () => tui.requestRender() });
		})) as ReviewUiResult | undefined;

		if (!result || result.action === "deny-file") return "deny-file";
		if (result.action === "accept-file") {
			for (const row of changedRows(currentRows)) row.decision = "accept";
			return currentRows;
		}
		if (result.action === "finish") return result.rows;
		if (result.action === "edit") {
			const row = currentRows.find((r) => r.id === result.rowId);
			if (!row) continue;
			const edited = await ctx.ui.input("Edit reviewed line", row.editedText ?? row.text);
			if (edited !== undefined) {
				row.decision = "edit";
				row.editedText = edited;
			}
		}
	}
}
