// The outline-delta contract as the tests see it: the only place that names the proposed wire fields, so a rename in
// review changes this file alone (outline-task.md, "Proposed shape").
//
// FINAL contract (outline-task.md "## FINAL contract"):
// - A page that holds an outline tells the Host what it holds: `known` = { version, lastId, lastOrdinal }.
// - A Host on the same derivation whose current outline still contains that last prompt answers with the prompts after
//   it and `base` = the held version. A compaction moves no ordinal, so it is a zero-prompt delta.
// - A reply is a delta iff it carries `base`; without it, it is a full outline (old Host, reader reset, derivation bump).
import type { ThreadOutline } from "../src/shared/protocol.ts";

type User = ThreadOutline["users"][number];
/** A `thread.outline` reply: today's full outline, or a delta on the held version. */
export type OutlineReply = ThreadOutline & { base?: string };

/** The request args of a page that holds `held`; without `held`, today's args (an old page). */
export function outlineArgs(threadId: string, held?: ThreadOutline): Record<string, unknown> {
	if (!held) return { threadId };
	const last = held.users.at(-1);
	return { threadId, known: { version: held.version, lastId: last?.id, lastOrdinal: last?.ordinal } };
}

/** The held state a request carries, or undefined for a request without it. */
export function heldOf(args: Record<string, unknown>): { version: string; lastId?: string; lastOrdinal?: number } | undefined {
	return args.known as never;
}

/** The base version a reply builds on, or undefined for a full outline. */
export const replyBase = (reply: OutlineReply): string | undefined => reply.base;

/** The window of the outline: the newest prompts the Host returns. */
export const OUTLINE_WINDOW = 2000;

/** The page's rule: a reply without a base replaces the outline; a delta on the held version appends, keeps the newest
 * 2000 and takes `truncated` from the reply; a delta on any other base is discarded, and the page asks once without
 * held state. */
export function applyOutline(held: ThreadOutline | undefined, reply: OutlineReply): ThreadOutline | "refetch" {
	const base = replyBase(reply);
	const { base: _, ...rest } = reply;
	if (base === undefined) return rest;
	if (!held || base !== held.version) return "refetch";
	return { ...rest, users: [...held.users, ...reply.users].slice(-OUTLINE_WINDOW) };
}

/** A reference Host for page fixtures: the delta when the current outline still contains the held last prompt, else
 * the full outline. `reset` models a reader reset or derivation bump: always full. */
export function hostReply(full: ThreadOutline, args: Record<string, unknown>, reset = false): OutlineReply {
	const known = heldOf(args);
	if (!known || reset || known.lastId === undefined) return full;
	let at = -1;
	for (let i = full.users.length - 1; i >= 0; i--) { const u: User = full.users[i]!; if (u.id === known.lastId && u.ordinal === known.lastOrdinal) { at = i; break; } }
	return at < 0 ? full : { ...full, users: full.users.slice(at + 1), base: known.version };
}

/** Bytes of a reply value on the wire (UTF-8 JSON); the frame envelope adds a fixed few bytes. */
export const replyBytes = (reply: unknown) => Buffer.byteLength(JSON.stringify(reply));
