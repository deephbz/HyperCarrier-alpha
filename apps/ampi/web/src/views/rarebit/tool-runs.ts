import type { PiBlock, PiEntry } from "../../../../src/shared/protocol.ts";

export type ToolRun = {
	kind: "run";
	id: string;
	entries: PiEntry[];
	/** The fragment key of each step, beside `entries`: the entry ID and the step's first source block, or its kind. */
	keys: string[];
	calls: number;
	errors: number;
	start?: number;
	end?: number;
	running: boolean;
	/** The collapsed line: counts per kind, in order of first appearance. */
	label: string;
};
export type LensPart = { kind: "entry"; entry: PiEntry; key: string } | ToolRun;

/** Custom entry kinds the run label names; any other kind is named by its entryKind prefix. */
const STEP_NAMES: [RegExp, string, string][] = [
	[/^(pi-team-bright|ptb)\./, "PTB msg", "PTB msgs"],
	[/^intercom_/, "intercom msg", "intercom msgs"],
	[/^(hc-)?auto-compact\./, "Auto Compact msg", "Auto Compact msgs"],
];

function stepName(entry: PiEntry): [string, string] | undefined {
	if (entry.kind === "compaction") return ["compaction", "compactions"];
	if (entry.kind === "reset") return ["context reset", "context resets"];
	if (entry.kind !== "custom") return undefined;
	const named = STEP_NAMES.find(([match]) => match.test(entry.entryKind));
	if (named) return [named[1], named[2]];
	const prefix = entry.entryKind.split(/[./:]/)[0] || "extension";
	return [`${prefix} msg`, `${prefix} msgs`];
}

/** Display-only grouping. Only user and assistant text are prose; every other entry is a run step.
 * Prose bounds the elapsed span; source entries remain intact. */
export function toolRuns(entries: PiEntry[], live = false): LensPart[] {
	const parts: LensPart[] = [];
	let run: ToolRun | undefined;
	let previous: number | undefined;
	const time = (ts?: number) => typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
	const flush = (end?: number) => {
		if (!run) return;
		if (end !== undefined) run.end = end;
		const calls = new Set<string>();
		const errors = new Set<string>();
		for (const entry of run.entries) {
			if (entry.kind === "assistant") for (const block of entry.blocks) if (block.type === "tool") calls.add(block.callId);
			if (entry.kind === "tool-result") {
				calls.add(entry.callId);
				if (entry.isError) errors.add(entry.callId);
			}
		}
		run.calls = calls.size;
		run.errors = errors.size;
		const counts = new Map<string, { names: [string, string]; n: number }>();
		if (calls.size) counts.set("tool call", { names: ["tool call", "tool calls"], n: calls.size });
		for (const entry of run.entries) {
			const names = stepName(entry);
			if (!names) continue;
			const count = counts.get(names[0]) ?? { names, n: 0 };
			count.n++;
			counts.set(names[0], count);
		}
		run.label = [...counts.values()].map(({ names, n }) => `${n} ${names[n === 1 ? 0 : 1]}`).join(", ") || "thinking";
		parts.push(run);
		run = undefined;
	};
	const step = (entry: PiEntry, suffix: string) => {
		const ts = "ts" in entry ? time(entry.ts) : undefined;
		run ??= { kind: "run", id: `${entry.id}:${suffix}`, entries: [], keys: [], calls: 0, errors: 0, label: "", start: previous ?? ts, end: ts, running: false };
		run.entries.push(entry);
		run.keys.push(`${entry.id}:${suffix}`);
		if (ts !== undefined) run.end = Math.max(run.end ?? ts, ts);
	};
	const prose = (entry: PiEntry, key: string) => {
		const ts = "ts" in entry ? time(entry.ts) : undefined;
		flush(ts);
		parts.push({ kind: "entry", entry, key });
		previous = ts;
	};
	for (const entry of entries) {
		if (entry.kind === "tool-result") step(entry, "result");
		else if (entry.kind === "assistant") {
			const { stop, error, ...content } = entry;
			let blocks: PiBlock[] = [];
			let first = 0;
			const drain = () => {
				if (blocks.length) step({ ...content, blocks }, String(first));
				blocks = [];
			};
			entry.blocks.forEach((block, i) => {
				if (block.type === "text" && block.text.trim()) {
					drain();
					prose({ ...content, blocks: [block] }, `${entry.id}:${i}`);
				} else if (block.type !== "text") {
					if (!blocks.length) first = i;
					blocks.push(block);
				}
			});
			drain();
			if (["error", "aborted", "length"].includes(entry.stop ?? "")) prose({ ...entry, blocks: [] }, `${entry.id}:status`);
		} else if (entry.kind === "user") prose(entry, entry.id);
		else if (entry.kind !== "system") step(entry, "step");
	}
	if (run) run.running = live;
	flush();
	return parts;
}

export function runDuration(start?: number, end?: number): string {
	if (start === undefined || end === undefined || end < start) return "time unavailable";
	const seconds = Math.floor((end - start) / 1000);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor(seconds % 3600 / 60);
	return hours ? `${hours}h ${minutes}m ${seconds % 60}s` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function runClock(ts?: number): string {
	return ts === undefined ? "?" : new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
