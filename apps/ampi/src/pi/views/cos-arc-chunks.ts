// Taken over from Chief of Staff's arc.mjs, arc-chunker/1. Reader records replace native JSONL entries.
// A turn starts at a real owner message; harness text, tool work and compactions stay inside it. A chunk closes only
// where a turn starts, at OWNER_TURNS, RAREBIT_CHARS or an idle gap. Directories only describe a chunk (`where`).
// Only the open trailing turn can regroup.
import { createHash } from "node:crypto";
import { isOwnerTurn } from "./cos-arc-asks.ts";
import { entryTime } from "./cos-timeline.ts";
import type { PiReaderEntry } from "./types.ts";

/** Names the chunking rules; it seeds every chunk hash and the Arc label version. */
export const CHUNKER_VERSION = "ampi-arc-chunker/3";
export const OWNER_TURNS = 12;
/** Rarebit evidence chars (user, stop, continuation, error and compaction text) before the excerpt clip. */
export const RAREBIT_CHARS = 40_000;
export const IDLE_MS = 2 * 3600_000;

export type Chunk = {
	id: string; index: number; hash: string; startAt: string | null; endAt: string | null;
	firstEntryId: string; lastEntryId: string; firstAsk: string | null; lastOwnerEntryId: string | null;
	ownerTurns: number; entries: number; toolCalls: number; where: string | null; idleBeforeMs: number | null;
	compactionEntryId: string | null;
};
type Stats = { ownerTurns: number; entries: number; toolCalls: number; chars: number; areas: Record<string, number> };
type Turn = { ids: string[]; startAt: string | null; endAt: string | null; startMs: number | null; endMs: number | null; compaction: string | null; owner: string | null; ask: string | null; stats: Stats };
export type Skeleton = { chunks: Chunk[]; evidence: Map<string, string>; excludedEntries: number; shortenedChunks: number };
const stats = (): Stats => ({ ownerTurns: 0, entries: 0, toolCalls: 0, chars: 0, areas: {} });
const body = (e: PiReaderEntry) => e.blocks?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") ?? e.text ?? "";
const clip = (s: string, max: number) => s.length <= max ? s : `${s.slice(0, Math.floor(max * .7))} …[shortened]… ${s.slice(-Math.floor(max * .25))}`;
const oneLine = (s: string, max: number) => clip(s.replace(/\s+/g, " ").trim(), max);
const containers = new Set(["packages", "apps", "services", "libs", "crates", "modules", "plugins", "projects", "src", "tools", "docs"]);

function areaOf(raw: string, cwd: string): string | null {
	let path = raw.trim().replace(/\\/g, "/");
	const base = cwd.replace(/\\/g, "/").replace(/\/$/, "");
	let outside = path.startsWith("~/");
	if (path.startsWith("/")) {
		if (base && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length + 1);
		else outside = true;
	}
	path = path.replace(/^\.\//, "");
	if (outside) {
		const home = /^(?:~|\/home\/[^/]+|\/Users\/[^/]+|\/root)\/(.*)$/.exec(path);
		const rest = (home ? home[1]! : path.replace(/^\//, "")).split("/").filter(Boolean);
		if (!rest.length) return null;
		if (rest[0]!.startsWith(".")) return `~/${rest[0]}`;
		return `${home ? "~/" : "/"}${rest.slice(0, Math.min(2, rest.length - 1) || 1).join("/")}`;
	}
	const parts = path.split("/").filter((p) => p && p !== ".");
	if (!parts.length || parts[0] === "..") return parts[0] === ".." ? "(parent dir)" : ".";
	if (parts.length === 1) return ".";
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
const dominant = (areas: Record<string, number>) => Object.entries(areas).filter(([name]) => name !== "." && name !== "(parent dir)").sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

/**
 * `rarebitChars` holds each entry's full Rarebit text length; stored occurrence text is clipped, so it is only the
 * fallback.
 */
export function chunkSession(records: PiReaderEntry[], evidenceInput: { selection: { occurrences: { sourceEntryId: string | null; outcome: string; text: string }[] }; imported: Set<string>; inheritedBefore: number; rarebitChars?: Map<string, number> }, cwd: string): Skeleton {
	const { selection, imported, inheritedBefore, rarebitChars } = evidenceInput;
	const selected = new Map(selection.occurrences.map((r) => [r.sourceEntryId, r]));
	const turns: Turn[] = [];
	let turn: Turn | undefined, excludedEntries = 0;
	for (const e of records) {
		const ms = entryTime(e.t), time = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
		if (imported.has(e.id) || ms < inheritedBefore) { excludedEntries++; continue; }
		const owner = e.role === "user" && isOwnerTurn({ kind: "user", text: body(e) }), compaction = e.kind === "compaction";
		if (!turn || owner) {
			turn = { ids: [], startAt: time, endAt: time, startMs: Number.isFinite(ms) ? ms : null, endMs: null, compaction: null, owner: null, ask: null, stats: stats() };
			turns.push(turn);
		}
		turn.ids.push(e.id); turn.stats.entries++;
		if (time) { turn.endAt = time; turn.endMs = ms; turn.startMs ??= ms; turn.startAt ??= time; }
		turn.stats.chars += rarebitChars?.get(e.id) ?? selected.get(e.id)?.text.length ?? 0;
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
		if (t.endMs !== null) previousEnd = t.endMs;
	}
	const evidence = new Map<string, string>();
	let shortenedChunks = 0;
	const byId = new Map(records.map((e) => [e.id, e]));
	for (const g of groups) {
		const c = g.chunk;
		Object.assign(c, { ownerTurns: g.stats.ownerTurns, entries: g.stats.entries, toolCalls: g.stats.toolCalls, where: dominant(g.stats.areas) });
		const lines: { id: string; priority: number; line: string; dropped?: boolean }[] = [];
		let clipped = false;
		const bounded = (raw: string, max: number) => { const value = raw.replace(/\s+/g, " ").trim(); clipped ||= value.length > max; return clip(value, max); };
		const add = (id: string, priority: number, line: string) => lines.push({ id, priority, line: `[${id}] ${line}` });
		for (const id of g.ids) {
			const e = byId.get(id)!, r = selected.get(id);
			if (e.kind === "compaction") add(id, 0, `EARLIER-CONTEXT (model-written compaction): ${bounded(e.summary ?? "", 700)}`);
			else if (r) add(id, r.outcome === "user" ? 0 : 1, `${r.outcome === "user" ? "USER" : "AGENT"}: ${bounded(r.text, r.outcome === "user" ? 600 : r.outcome === "continuation" ? 160 : 420)}`);
			for (const b of e.blocks ?? []) if (b.type === "toolCall") add(id, /^(edit|write|multi_?edit|apply_patch|patch|create|str_replace)/i.test(b.name ?? "") ? 2 : 3, `TOOL ${b.name}: ${bounded(JSON.stringify(b.args ?? {}), 140)}`);
			if (e.result?.isError) add(id, 2, `TOOL ERROR: ${bounded(e.result.text, 140)}`);
		}
		let size = lines.reduce((n, l) => n + l.line.length + 1, 0), omitted = 0;
		for (let priority = 3; priority >= 0 && size > 7000; priority--) for (let i = lines.length - 1; i >= 0 && size > 7000; i--) {
			const l = lines[i]!; if (l.priority !== priority || l.dropped) continue;
			if (priority === 0) { const short = `${l.line.slice(0, 220)}…`; if (short.length >= l.line.length) continue; size -= l.line.length - short.length; l.line = short; }
			else { l.dropped = true; size -= l.line.length + 1; }
			omitted++;
		}
		if (clipped || omitted) shortenedChunks++;
		const excerpt = `${omitted ? `(omitted / shortened for length: ${omitted} lines)\n` : ""}${lines.filter((l) => !l.dropped).map((l) => l.line).join("\n")}`;
		evidence.set(c.id, excerpt);
		c.hash = createHash("sha256").update(CHUNKER_VERSION).update(JSON.stringify([g.ids, excerpt])).digest("hex");
	}
	return { chunks: groups.map((g) => g.chunk), evidence, excludedEntries, shortenedChunks };
}
