// Find in one open Session (FindBar): which match is current, and when to ask the hub for another window. The hub owns
// the windows (search.ts findCollector); this module owns the reader's place among them. It has no React and no DOM.
import type { FindAsk, FindWindow, SearchHit, SearchResult } from "../../../src/pi/search.ts";
import type { FindReply } from "../../../src/shared/protocol.ts";

/** One scope of a Find result: its matches, the window they form, and the scope's total. */
export type Scoped = { matches: SearchHit[]; window: FindWindow; total: number };
/**
 * A scope's matches are the hits in its window. A hub without windows sends the first matches of each scope; they form
 * a window that starts at its first match.
 */
export function scoped(value: SearchResult | undefined, tools: boolean): Scoped {
	const window = value?.windows?.[tools ? "all" : "prose"];
	const matches = (value?.hits ?? []).filter((hit) => (tools || hit.prose) && (!window || (hit.at! >= window.first && hit.at! <= window.last)));
	const total = (tools ? value?.total : value?.proseTotal) ?? matches.length;
	return { matches, total, window: window ?? { first: 0, last: -1, skipped: 0, start: 0, size: matches.length } };
}

/** Where a wrap took the reader. The Find bar shows it until the next step. */
export type Wrap = "top" | "bottom";
/**
 * What the Find bar shows. `at` is the current match in `matches`; it is undefined while the result has no place for
 * the reader: the hub could not find the reader's entry in its copy, or it has no windows. Then the counter shows the
 * total and the reader stays where they are. `indexing`: the Host has not indexed the Session yet, and the request
 * waits for it.
 */
export type FindView = {
	open: boolean; query: string; busy: boolean; indexing: boolean; error?: string; tools: boolean; filter: boolean;
	matches: SearchHit[]; total: number; skipped: number; at?: number; wrapped?: Wrap; scanned: number; more: boolean;
};

export type FindIo = {
	/** One `thread.find` request. */
	find: (query: string, ask: FindAsk) => Promise<FindReply>;
	/** The entry at the reader's place, or undefined when the transcript is hidden. */
	reading: () => string | undefined;
	/** Shows a match in the full transcript. */
	reveal: (hit: SearchHit) => void;
	/** Typing settles this long before Find asks: one scan per settled query, never one per keystroke. */
	settleMs: number;
};

/**
 * One Find session. One scan per settled query serves both scopes: prose (default) and + Tools. A result opens at the
 * first match at or after the reader's entry, as a browser's Find does. A step past a window's edge asks for the
 * window around that edge; a wrap past the scope's first or last match asks for the head or the tail. At most one
 * request is in flight: steps during it do nothing, and a new query supersedes it. A request the Host cannot answer
 * before it indexes the Session stays in flight until `indexed`; no timer asks again.
 */
export class FindSession {
	#view: FindView = { open: false, query: "", busy: false, indexing: false, tools: false, filter: false, matches: [], total: 0, skipped: 0, scanned: 0, more: false };
	#value?: SearchResult;
	#error?: string;
	#at?: number;
	#wrapped?: Wrap;
	/** The one retry an unplaced result allows: the copy may have caught up with the reader's entry. */
	#retried = false;
	#pending = false;
	/** The in-flight request that waits for the Host's index. */
	#waiting?: () => void;
	#generation = 0;
	#timer?: ReturnType<typeof setTimeout>;
	#listeners = new Set<() => void>();

	readonly io: FindIo;
	constructor(io: FindIo) { this.io = io; }

	get = () => this.#view;
	subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };

	show() { if (!this.#view.open) { this.#view = { ...this.#view, open: true }; this.#search(); } }
	close() { this.#cancel(); this.#value = undefined; this.#error = undefined; this.#view = { ...this.#view, open: false, filter: false }; this.#emit(); }
	dispose() { this.#cancel(); this.#listeners.clear(); }
	/** The Host announced an indexed copy of the Session: a request that waits for it asks again, once. */
	indexed() { const again = this.#waiting; this.#waiting = undefined; again?.(); }
	setQuery(query: string) {
		const same = query.trim() === this.#view.query.trim();
		this.#view = { ...this.#view, query };
		if (same) this.#emit(); else this.#search();
	}
	/** The other scope starts at its first match at or after the current one. */
	setTools(tools: boolean) {
		const from = this.#current()?.at ?? 0;
		this.#view = { ...this.#view, tools };
		this.#wrapped = undefined;
		const { matches } = this.#scope();
		if (this.#at !== undefined && matches.length) {
			const j = matches.findIndex((hit) => hit.at! >= from);
			return this.#land(j < 0 ? matches.length - 1 : j);
		}
		this.#emit();
	}
	/** Turning Filter off returns the reader to the current match in the full transcript. */
	setFilter(filter: boolean) {
		if (filter === this.#view.filter) return;
		const hit = this.#current();
		this.#view = { ...this.#view, filter };
		if (!filter && hit) this.io.reveal(hit);
		this.#emit();
	}
	/** Shows the full transcript at match `k` of the window. */
	pick(k: number) { this.#view = { ...this.#view, filter: false }; this.#wrapped = undefined; this.#land(k); }
	/** The window before the current one, from its first match back. */
	earlier() {
		const { matches, window } = this.#scope();
		if (!this.#pending && this.#value?.windows && window.skipped > 0 && matches.length) this.#edge(matches[0]!.entry, -1);
	}
	step(by: 1 | -1) {
		const value = this.#value;
		const { matches, window, total } = this.#scope();
		if (this.#pending || !value || !matches.length) return;
		this.#wrapped = undefined;
		if (this.#at === undefined) {
			// The hub could not place the reader's entry: ask once more. After that, forward is the first match and back
			// is the last.
			const from = value.windows && value.anchored === false && !this.#retried ? this.io.reading() : undefined;
			if (!from) return this.#end(by > 0 ? "top" : "bottom");
			this.#retried = true;
			return this.#ask({ from }, (result) => result.anchored === false ? this.#end(by > 0 ? "top" : "bottom") : this.#place(by));
		}
		const next = this.#at + by;
		if (next >= 0 && next < matches.length) return this.#land(next);
		if (value.windows && next >= matches.length && window.skipped + matches.length < total) return this.#edge(matches.at(-1)!.entry, 1);
		if (value.windows && next < 0 && window.skipped > 0) return this.#edge(matches[0]!.entry, -1);
		return this.#end(next < 0 ? "bottom" : "top", true);
	}

	#scope() { return scoped(this.#value, this.#view.tools); }
	#current() { return this.#at === undefined ? undefined : this.#scope().matches[this.#at]; }
	#cancel() { ++this.#generation; this.#pending = false; this.#waiting = undefined; clearTimeout(this.#timer); }
	#search() {
		this.#cancel();
		this.#value = undefined; this.#error = undefined; this.#at = undefined; this.#wrapped = undefined; this.#retried = false;
		const q = this.#view.query.trim();
		if (!this.#view.open || !q) return this.#emit();
		this.#pending = true;
		this.#emit();
		this.#timer = setTimeout(() => {
			const from = this.io.reading();
			this.#ask(from ? { from } : {}, (result) => result.windows && result.anchored !== false ? this.#place(1) : this.#emit());
		}, this.io.settleMs);
	}
	#ask(ask: FindAsk, then: (result: SearchResult) => void) {
		const token = ++this.#generation, q = this.#view.query.trim();
		this.#pending = true;
		this.io.find(q, ask).then(
			(reply) => {
				if (token !== this.#generation) return;
				if ("indexing" in reply) { this.#waiting = () => this.#ask(ask, then); return this.#emit(); }
				this.#pending = false; this.#value = reply; this.#error = undefined; this.#at = undefined;
				then(reply);
			},
			(error) => {
				if (token !== this.#generation) return;
				this.#pending = false; this.#error = String(error);
				this.#emit();
			},
		);
	}
	/** Opens an anchored result: forward at the first match at or after the reader's entry, back at the one before it. */
	#place(by: 1 | -1) {
		const { matches, window } = this.#scope();
		const i = by > 0 ? window.start : window.start - 1;
		if (i >= 0 && i < matches.length) return this.#land(i);
		this.#end(by > 0 ? "top" : "bottom", matches.length > 0);
	}
	/** The window around `entry`, at the match `by` steps from it. An entry the hub no longer finds leaves Find unplaced. */
	#edge(entry: string, by: 1 | -1) {
		this.#ask({ from: entry }, (result) => {
			if (result.anchored === false) return this.#emit();
			const { matches, window } = this.#scope();
			const i = matches.findIndex((hit) => hit.entry === entry);
			this.#land(Math.max(0, Math.min(matches.length - 1, (i < 0 ? window.start : i) + by)));
		});
	}
	/** The scope's first (top) or last (bottom) match; the head or the tail window when the current one lacks it. */
	#end(to: Wrap, wrap = false) {
		const { matches, window, total } = this.#scope();
		const held = !this.#value?.windows || (to === "top" ? window.skipped === 0 : window.skipped + matches.length >= total);
		const land = () => { const { matches } = this.#scope(); if (matches.length) this.#land(to === "top" ? 0 : matches.length - 1, wrap ? to : undefined); else this.#emit(); };
		if (held) return land();
		this.#ask(to === "top" ? {} : { tail: true }, land);
	}
	#land(i: number, wrapped?: Wrap) {
		this.#at = i; this.#wrapped = wrapped;
		const hit = this.#scope().matches[i];
		if (hit && !this.#view.filter) this.io.reveal(hit);
		this.#emit();
	}
	#emit() {
		const { matches, window, total } = this.#scope();
		const at = this.#at === undefined ? undefined : Math.min(this.#at, Math.max(0, matches.length - 1));
		this.#view = {
			...this.#view, busy: this.#pending && !this.#waiting && !this.#value && !this.#error, indexing: Boolean(this.#waiting), error: this.#error, matches, total, skipped: window.skipped,
			at: matches.length ? at : undefined, wrapped: this.#wrapped, scanned: this.#value?.scanned ?? 0, more: total > matches.length,
		};
		for (const listener of this.#listeners) listener();
	}
}
