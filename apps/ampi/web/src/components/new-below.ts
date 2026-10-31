import type { PiEntry } from "../../../src/shared/protocol.ts";
import { plural } from "../plural.ts";

/**
 * What arrived below a reader who left the end: `messages` counts user prompts and assistant prose; `steps` counts
 * every other item (tool calls, thinking, compaction, resets, extension messages, model changes). A tool result
 * belongs to its call, so it adds nothing. An assistant entry with no text, thinking or tool block still says
 * something to the reader (an error, a stop), so it counts as one message.
 */
export type NewBelow = { messages: number; steps: number };

export function countNew(entries: readonly PiEntry[]): NewBelow {
	const out = { messages: 0, steps: 0 };
	for (const e of entries) {
		if (e.kind === "tool-result") continue;
		if (e.kind === "user") out.messages++;
		else if (e.kind === "assistant") {
			const blocks = e.blocks ?? [];
			const prose = blocks.some((b) => b.type === "text" && b.text.trim());
			const steps = blocks.filter((b) => b.type === "tool" || b.type === "thinking").length;
			if (prose || steps === 0) out.messages++;
			out.steps += steps;
		} else out.steps++;
	}
	return out;
}

/**
 * Entries after the reader's last-seen entry, counted. A Pi thread serves a bounded tail, so its length can stay or
 * shrink while entries arrive: count by identity. A last-seen entry that slid out of the window gives "some".
 */
export function newBelow(entries: readonly PiEntry[], away: { last?: string } | undefined): NewBelow | "some" | undefined {
	if (!away) return undefined;
	const at = away.last === undefined ? -1 : entries.findIndex((e) => e.id === away.last);
	if (away.last !== undefined && at < 0) return "some";
	return at === entries.length - 1 ? undefined : countNew(entries.slice(at + 1));
}

/** The chip's words: "↓ 2 new messages, 5 tool uses"; a zero part is left out; nothing countable reads "↓ new". */
export function newBelowLabel(fresh: NewBelow | "some"): string {
	if (fresh === "some" || (fresh.messages === 0 && fresh.steps === 0)) return "↓ new";
	const { messages, steps } = fresh;
	if (!messages) return `↓ ${steps} new ${plural(steps, "tool use")}`;
	return `↓ ${messages} new ${plural(messages, "message")}${steps ? `, ${steps} ${plural(steps, "tool use")}` : ""}`;
}
