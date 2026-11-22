import type { PiEntry } from "../../../src/shared/protocol.ts";
import { runDuration } from "../views/rarebit/tool-runs.ts";

export type RunningToolCall = {
	callId: string;
	name: string;
	/** Start timestamp (ms): assistant entry append time, advanced to the latest sibling tool-result in the same turn. */
	startedAt: number;
};

export const TOOL_ELAPSED_WARN_MS = 10_000;
export const TOOL_ELAPSED_MAX_MS = 1000 * 60 * 1000;
const LOG_MIN = Math.log10(TOOL_ELAPSED_WARN_MS / 1000);
const LOG_SPAN = Math.log10(TOOL_ELAPSED_MAX_MS / 1000) - LOG_MIN;

function finiteTs(ts?: number): number | undefined {
	return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
}

/**
 * Derives currently running tool calls and their start timestamps from the single owner set `open` (from `openCalls`)
 * and `busy`. For sequential batches in one assistant turn, advancing `startedAt` to the latest sibling `tool-result`
 * timestamp avoids charging earlier finished calls' time to the currently running call.
 */
export function runningToolCalls(entries: readonly PiEntry[], open: ReadonlySet<string>, busy: boolean): Map<string, RunningToolCall> {
	const out = new Map<string, RunningToolCall>();
	if (!busy || open.size === 0) return out;
	const resultTs = new Map<string, number>();
	for (const entry of entries) {
		if (entry.kind !== "tool-result") continue;
		const ts = finiteTs(entry.ts);
		if (ts !== undefined) resultTs.set(entry.callId, ts);
	}
	for (const entry of entries) {
		if (entry.kind !== "assistant") continue;
		const openBlocks = entry.blocks.filter((b): b is Extract<typeof b, { type: "tool" }> => b.type === "tool" && open.has(b.callId));
		if (openBlocks.length === 0) continue;
		let startedAt = finiteTs(entry.ts);
		if (startedAt === undefined) continue;
		for (const block of entry.blocks) {
			if (block.type !== "tool") continue;
			const ts = resultTs.get(block.callId);
			if (ts !== undefined && ts > startedAt) startedAt = ts;
		}
		for (const block of openBlocks) out.set(block.callId, { callId: block.callId, name: block.name, startedAt });
	}
	return out;
}

/** Picks the longest-running open tool call (earliest `startedAt`; first in order on tie) and total parallel count. */
export function longestRunningToolCall(running: ReadonlyMap<string, RunningToolCall>): { call: RunningToolCall; parallelCount: number } | undefined {
	let best: RunningToolCall | undefined;
	for (const call of running.values()) {
		if (!best || call.startedAt < best.startedAt) best = call;
	}
	return best ? { call: best, parallelCount: running.size } : undefined;
}

/** Formats elapsed duration for a running tool call (negative clock skew clamps to 0s). */
export function formatToolElapsed(elapsedMs: number): string {
	const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
	return runDuration(0, ms);
}

/**
 * Normal color below 10s; log-scale orange (--warn) to red (--err) from 10s to 1000m (clamped at 1).
 */
export function toolElapsedTone(elapsedMs: number): { text: string; ratio: number | null; pct: number | null } {
	const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
	const text = formatToolElapsed(ms);
	if (ms < TOOL_ELAPSED_WARN_MS) return { text, ratio: null, pct: null };
	const ratio = Math.min(1, Math.max(0, (Math.log10(ms / 1000) - LOG_MIN) / LOG_SPAN));
	return { text, ratio, pct: Math.round(ratio * 100) };
}
