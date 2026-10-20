// Taken over from Chief of Staff's arc.mjs, arc-chunker/1. Reader records replace native JSONL entries.
// A turn starts at a real owner message; harness text, tool work and compactions stay inside it. A chunk closes only
// where a turn starts, at OWNER_TURNS, RAREBIT_CHARS or an idle gap (cos-arc-rules.ts). Directories only describe a
// chunk (`where`), and only inside a repository cwd.
// Only the open trailing turn can regroup.
import { createHash } from "node:crypto";
import { isOwnerTurn } from "./cos-arc-asks.ts";
import { entryTime } from "./cos-timeline.ts";
import { IDLE_MS, OWNER_TURNS, RAREBIT_CHARS } from "./cos-arc-rules.ts";
import type { PiReaderEntry } from "./types.ts";

export { IDLE_MS, OWNER_TURNS, RAREBIT_CHARS };

/** Names the chunking rules; it seeds every chunk hash and the Arc label version. */
export const CHUNKER_VERSION = "ampi-arc-chunker/4";
/** Names the label excerpt rules; it seeds every chunk hash, so a change refreshes the labels. */
export const EXCERPT_VERSION = "ampi-arc-excerpt/2";
/** Label excerpt budget: 7000 chars plus a quarter of the chunk's Rarebit chars above that, at most 16000. */
export const excerptBudget = (chars: number) => Math.min(16_000, 7000 + Math.floor(Math.max(0, chars - 7000) / 4));

export type Chunk = {
	id: string; index: number; hash: string; startAt: string | null; endAt: string | null;
	firstEntryId: string; lastEntryId: string; firstAsk: string | null; lastOwnerEntryId: string | null;
	ownerTurns: number; entries: number; toolCalls: number; where: string | null; idleBeforeMs: number | null;
	compactionEntryId: string | null;
};
type Stats = { ownerTurns: number; entries: number; toolCalls: number; chars: number; areas: Record<string, number> };
/** `activeEndMs`: the last entry time before the turn's first harness wake; the idle gap runs from there. */
type Turn = { ids: string[]; startAt: string | null; endAt: string | null; startMs: number | null; endMs: number | null; activeEndMs: number | null; woken: boolean; compaction: string | null; owner: string | null; ask: string | null; stats: Stats };
export type Skeleton = { chunks: Chunk[]; evidence: Map<string, string>; excludedEntries: number; shortenedChunks: number };
const stats = (): Stats => ({ ownerTurns: 0, entries: 0, toolCalls: 0, chars: 0, areas: {} });
const body = (e: PiReaderEntry) => e.blocks?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") ?? e.text ?? "";
const clip = (s: string, max: number) => s.length <= max ? s : `${s.slice(0, Math.floor(max * .7))} …[shortened]… ${s.slice(-Math.floor(max * .25))}`;
const oneLine = (s: string, max: number) => clip(s.replace(/\s+/g, " ").trim(), max);
const containers = new Set(["packages", "apps", "services", "libs", "crates", "modules", "plugins", "projects", "src", "tools", "docs"]);

const HOME = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/;

/**
 * The repository area of a path: its top directory, or two levels under a container such as `apps`. Only a path inside
 * the Session's cwd has one, and only when the cwd is a repository: neither the filesystem root nor a home directory.
 * `/dev/null`, `/tmp`, `~` and paths outside the cwd describe no area.
 */
export function areaOf(raw: string, cwd: string): string | null {
	const base = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, ""), home = HOME.exec(base)?.[0];
	if (!base.startsWith("/") || home === base) return null;
	let path = raw.trim().replace(/\\/g, "/");
	if (path === "~" || path.startsWith("~/")) { if (!home) return null; path = home + path.slice(1); }
	if (path.startsWith("/")) { if (!path.startsWith(`${base}/`)) return null; path = path.slice(base.length + 1); }
	const parts = path.split("/").filter((p) => p && p !== ".");
	if (parts.length < 2 || parts.includes("..")) return null;
	return containers.has(parts[0]!) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

function pathsInArgs(name: string, raw: unknown): { path: string; dir: boolean }[] {
	if (!raw || typeof raw !== "object") return [];
	const args = raw as Record<string, unknown>, out: { path: string; dir: boolean }[] = [];
	for (const key of ["path", "file_path", "filePath", "file", "target", "dir", "directory", "cwd"]) if (typeof args[key] === "string") out.push({ path: args[key], dir: key === "dir" || key === "directory" || key === "cwd" });
	if (Array.isArray(args.paths)) for (const path of args.paths) if (typeof path === "string") out.push({ path, dir: false });
	if (typeof args.command === "string" && /bash|shell|exec/i.test(name)) {
		const command = args.command.slice(0, 2000), cd = /(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(command);
		const base = cd ? cd[1]!.replace(/^["']|["']$/g, "") : null;
		if (base) out.push({ path: base, dir: true });
		let count = 0;
		for (const token of command.split(/[\s;&|()<>"'`=,]+/)) {
			if (count >= 8) break;
			if (!token.includes("/") || token === base || token.startsWith("-") || /^[a-z][\w+.-]*:\/\//i.test(token) || token.length > 200 || !/[\w-]\/[\w.-]/.test(token)) continue;
			count++;
			out.push({ path: !token.startsWith("/") && !token.startsWith("~") && base?.startsWith("/") ? `${base.replace(/\/$/, "")}/${token}` : token, dir: token.endsWith("/") });
		}
	}
	return out;
}
type ExcerptLine = { kind: "owner" | "user" | "context" | "stop" | "agent" | "tool"; line: string; keep?: boolean; drop?: boolean };

/**
 * Every owner USER and EARLIER-CONTEXT line, the last AGENT line before each owner turn and the chunk's final stop
 * stay. Harness USER lines (wakes, Rarebit Recall) belong to the runs between them. The rest of the budget goes evenly
 * to those runs, from each run's head and tail; a marker counts the dropped middle. When the kept lines alone overflow,
 * AGENT lines shorten first, then owner and context lines; then kept lines drop, AGENT lines first and oldest first.
 * The final stop never shortens, and the text never exceeds the budget.
 */
function trimExcerpt(lines: ExcerptLine[], budget: number): { text: string; omitted: number } {
	const size = (l: ExcerptLine) => l.line.length + 1, MARK = 24, HEADER = 48;
	const agents = lines.flatMap((l, i) => l.kind === "stop" || l.kind === "agent" ? [i] : []);
	const final = agents.filter((i) => lines[i]!.kind === "stop").at(-1) ?? agents.at(-1);
	if (final !== undefined) lines[final]!.keep = true;
	lines.forEach((l, i) => {
		if (l.kind === "owner" || l.kind === "context") l.keep = true;
		if (l.kind === "owner") { const before = agents.filter((j) => j < i).at(-1); if (before !== undefined && !lines.slice(before + 1, i).some((x) => x.kind === "owner")) lines[before]!.keep = true; }
	});
	if (lines.reduce((n, l) => n + size(l), 0) <= budget) return { text: lines.map((l) => l.line).join("\n"), omitted: 0 };
	// Each run and each dropped kept line reserves one omitted-lines marker.
	const free = (l: ExcerptLine | undefined) => l && !l.keep && !l.drop;
	const markers = () => lines.reduce((n, l, i) => n + (l.drop || (free(l) && !free(lines[i - 1])) ? 1 : 0), 0);
	const room = () => budget - HEADER - markers() * MARK - lines.reduce((n, l) => n + (l.keep ? size(l) : 0), 0);
	let omitted = 0;
	const tiers: [ExcerptLine["kind"][], number | null][] = [[["agent", "stop"], 220], [["owner", "context"], 220], [["agent", "stop"], null], [["owner", "context"], 100], [["owner", "context"], null]];
	for (const [kinds, max] of tiers) for (let i = 0; i < lines.length && room() < 0; i++) {
		const l = lines[i]!; if (!l.keep || i === final || !kinds.includes(l.kind)) continue;
		if (max === null) { l.keep = false; l.drop = true; continue; }
		const short = `${l.line.slice(0, max)}…`; if (short.length >= l.line.length) continue;
		l.line = short; omitted++;
	}
	const runs: number[][] = [];
	lines.forEach((l, i) => { if (!free(l)) return; const last = runs.at(-1); if (last?.at(-1) === i - 1) last.push(i); else runs.push([i]); });
	const kept = new Set<number>(), cost = (run: number[]) => run.reduce((n, i) => n + size(lines[i]!), 0);
	let left = room(), open = left > 0 ? runs : [], share = 0;
	for (;;) {
		share = open.length ? left / open.length : 0;
		const whole = open.filter((run) => cost(run) <= share);
		if (!whole.length) break;
		for (const run of whole) { run.forEach((i) => kept.add(i)); left -= cost(run); }
		open = open.filter((run) => !whole.includes(run));
	}
	for (const run of open) {
		let allow = share, a = 0, b = run.length - 1, headFirst = true;
		while (a <= b) {
			const side = [headFirst ? a : b, headFirst ? b : a].find((i) => size(lines[run[i]!]!) <= allow);
			if (side === undefined) break;
			kept.add(run[side]!); allow -= size(lines[run[side]!]!);
			if (side === a) { a++; headFirst = false; } else { b--; headFirst = true; }
		}
	}
	const out: string[] = [];
	let gap = 0;
	lines.forEach((l, i) => {
		if (l.keep || kept.has(i)) { if (gap) out.push(`… ${gap} lines omitted`); gap = 0; out.push(l.line); } else { gap++; omitted++; }
	});
	if (gap) out.push(`… ${gap} lines omitted`);
	return { text: `(omitted / shortened for length: ${omitted} lines)\n${out.join("\n")}`, omitted };
}

const dominant = (areas: Record<string, number>) => Object.entries(areas).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

/**
 * `rarebitChars` holds each entry's full Rarebit text length; stored occurrence text is clipped, so it never counts.
 * An owner turn is a `human` entry (the reader's kind for a user message that Rarebit keeps) that isOwnerTurn accepts,
 * so askCandidates and the chunker find the same owner turns.
 */
export function chunkSession(records: PiReaderEntry[], evidenceInput: { selection: { occurrences: { sourceEntryId: string | null; outcome: string; text: string }[] }; imported: Set<string>; inheritedBefore: number; rarebitChars: Map<string, number> }, cwd: string): Skeleton {
	const { selection, imported, inheritedBefore, rarebitChars } = evidenceInput;
	const selected = new Map(selection.occurrences.map((r) => [r.sourceEntryId, r]));
	const turns: Turn[] = [];
	let turn: Turn | undefined, excludedEntries = 0;
	for (const e of records) {
		const ms = entryTime(e.t), time = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
		if (imported.has(e.id) || ms < inheritedBefore) { excludedEntries++; continue; }
		const owner = e.kind === "human" && isOwnerTurn({ kind: "user", text: body(e) }), compaction = e.kind === "compaction";
		if (!turn || owner) {
			turn = { ids: [], startAt: time, endAt: time, startMs: Number.isFinite(ms) ? ms : null, endMs: null, activeEndMs: null, woken: false, compaction: null, owner: null, ask: null, stats: stats() };
			turns.push(turn);
		}
		turn.ids.push(e.id); turn.stats.entries++;
		// A harness wake: an injected entry (custom_message or a known injected user text), or a relayed user message.
		if ((e.kind === "human" || e.kind === "injected" || e.role === "user") && !owner) turn.woken = true;
		if (time) { turn.endAt = time; turn.endMs = ms; turn.startMs ??= ms; turn.startAt ??= time; if (!turn.woken) turn.activeEndMs = ms; }
		turn.stats.chars += rarebitChars.get(e.id) ?? 0;
		if (compaction) { turn.compaction ??= e.id; turn.stats.chars += e.summary?.length ?? 0; }
		if (owner) { turn.stats.ownerTurns++; turn.owner = e.id; turn.ask = oneLine(body(e), 160) || null; }
		else if (e.role === "assistant") {
			if (e.stop === "error") turn.stats.chars += e.error?.length ?? 0;
			for (const b of e.blocks ?? []) if (b.type === "toolCall") {
				turn.stats.toolCalls++;
				for (const { path, dir } of pathsInArgs(b.name ?? "", b.args)) {
					const area = areaOf(dir ? `${path.replace(/\/$/, "")}/_` : path, cwd);
					if (area) turn.stats.areas[area] = (turn.stats.areas[area] ?? 0) + 1;
				}
			}
		}
	}
	const groups: { chunk: Chunk; stats: Stats; ids: string[] }[] = [];
	let current: typeof groups[number] | undefined, previousEnd: number | null = null;
	for (const t of turns) {
		const gap = previousEnd !== null && t.startMs !== null ? t.startMs - previousEnd : 0;
		if (current && t.owner && (current.stats.ownerTurns >= OWNER_TURNS || current.stats.chars >= RAREBIT_CHARS || gap > IDLE_MS)) current = undefined;
		if (!current) {
			const chunk: Chunk = { id: `c${groups.length}`, index: groups.length, hash: "", startAt: t.startAt, endAt: t.endAt, firstEntryId: t.ids[0]!, lastEntryId: t.ids[0]!, firstAsk: null, lastOwnerEntryId: null, ownerTurns: 0, entries: 0, toolCalls: 0, where: null, idleBeforeMs: groups.length && gap > 0 ? gap : null, compactionEntryId: null };
			current = { chunk, stats: stats(), ids: [] }; groups.push(current);
		}
		current.ids.push(...t.ids);
		const c = current.chunk;
		c.lastEntryId = t.ids.at(-1)!; if (t.endAt) c.endAt = t.endAt;
		for (const key of ["ownerTurns", "entries", "toolCalls", "chars"] as const) current.stats[key] += t.stats[key];
		for (const [area, n] of Object.entries(t.stats.areas)) current.stats.areas[area] = (current.stats.areas[area] ?? 0) + n;
		c.compactionEntryId ??= t.compaction;
		if (t.owner) { c.lastOwnerEntryId = t.owner; c.firstAsk ??= t.ask; }
		if (t.activeEndMs !== null) previousEnd = t.activeEndMs;
	}
	const evidence = new Map<string, string>(), owners = new Set(turns.flatMap((t) => t.owner ? [t.owner] : []));
	let shortenedChunks = 0;
	const byId = new Map(records.map((e) => [e.id, e]));
	for (const g of groups) {
		const c = g.chunk;
		Object.assign(c, { ownerTurns: g.stats.ownerTurns, entries: g.stats.entries, toolCalls: g.stats.toolCalls, where: dominant(g.stats.areas) });
		const lines: ExcerptLine[] = [];
		let clipped = false;
		const bounded = (raw: string, max: number) => { const value = raw.replace(/\s+/g, " ").trim(); clipped ||= value.length > max; return clip(value, max); };
		const add = (id: string, kind: ExcerptLine["kind"], line: string) => lines.push({ kind, line: `[${id}] ${line}` });
		for (const id of g.ids) {
			const e = byId.get(id)!, r = selected.get(id);
			if (e.kind === "compaction") add(id, "context", `EARLIER-CONTEXT (model-written compaction): ${bounded(e.summary ?? "", 700)}`);
			else if (r?.outcome === "user") add(id, owners.has(id) ? "owner" : "user", `USER: ${bounded(r.text, 600)}`);
			else if (r) add(id, r.outcome === "stop" ? "stop" : "agent", `AGENT: ${bounded(r.text, r.outcome === "continuation" ? 160 : 420)}`);
			for (const b of e.blocks ?? []) if (b.type === "toolCall") add(id, "tool", `TOOL ${b.name}: ${bounded(JSON.stringify(b.args ?? {}), 140)}`);
			if (e.result?.isError) add(id, "tool", `TOOL ERROR: ${bounded(e.result.text, 140)}`);
		}
		const { text: excerpt, omitted } = trimExcerpt(lines, excerptBudget(g.stats.chars));
		if (clipped || omitted) shortenedChunks++;
		evidence.set(c.id, excerpt);
		c.hash = createHash("sha256").update(CHUNKER_VERSION).update(EXCERPT_VERSION).update(JSON.stringify([g.ids, excerpt])).digest("hex");
	}
	return { chunks: groups.map((g) => g.chunk), evidence, excludedEntries, shortenedChunks };
}
