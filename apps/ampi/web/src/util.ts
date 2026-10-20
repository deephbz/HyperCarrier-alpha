import type { ThreadSummary } from "../../src/shared/protocol.ts";
import { navigate } from "./nav.ts";
import { perfMark } from "./perf.ts";

/** The shortcut modifier as the platform shows it: ⌘ on a Mac, Ctrl+ elsewhere. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export function ago(ts: number | undefined, now = Date.now()): string {
	if (!ts) return "";
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 45) return "now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.round(h / 24);
	return `${d}d`;
}

export function clock(ts: number | undefined): string {
	if (!ts) return "";
	// 24-hour everywhere, as Rarebit's spec requires, so a message reads the same in the transcript and the panel.
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function tokens(n: number | undefined): string {
	if (n === undefined) return "?";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function money(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return "<$0.01";
	return `$${n.toFixed(2)}`;
}

export const ACTIVITY_LABEL: Record<ThreadSummary["activity"], string> = {
	idle: "idle",
	thinking: "thinking",
	streaming: "writing",
	tools: "running tools",
	retrying: "retrying",
	compacting: "compacting",
	waiting: "waiting on subthreads",
};

export function isBusy(t: ThreadSummary | undefined): boolean {
	return t !== undefined && t.activity !== "idle";
}

/** Does this thread need the owner? Only positive evidence counts (domain.md attention rules). */
export function needsYou(t: ThreadSummary): string | undefined {
	return attentionOf(t)[0]?.reason;
}

/** Every positive signal that the owner is needed, each naming the authority it came from. */
export function attentionOf(t: ThreadSummary): { source: string; reason: string }[] {
	const out: { source: string; reason: string }[] = [];
	if (t.lastError) out.push({ source: "error", reason: t.lastError });
	for (const a of t.attention ?? []) out.push(a);
	if (t.rarebit?.status === "needs_attention" && t.rarebit.fresh) out.push({ source: "Rarebit", reason: t.rarebit.reason ?? "needs you" });
	return out;
}

/**
 * The GUI's one address space (docs/one-gui-views.md, "Links"):
 * - `#/h/<host>/t/<thread>?e=<entry>&p=<panel>`: a Session, optionally scrolled to one entry, with a side panel open;
 * - `#/h/<host>/x/<term>`: a terminal;
 * - `#/v/<page>/<rest…>?<query>`: a page (Chief of Staff timeline, arcs, …).
 */
export type Route = { host?: string; thread?: string; term?: string; entry?: string; panel?: string; page?: string; rest: string[]; query: URLSearchParams };

export function hashRoute(): Route {
	return parseRoute(location.hash);
}

export function parseRoute(hash: string): Route {
	const [path = "", search = ""] = hash.replace(/^#/, "").split("?");
	const query = new URLSearchParams(search);
	const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
	if (parts[0] === "v" && parts[1]) return { page: parts[1], rest: parts.slice(2), query };
	if (parts[0] !== "h" || !parts[1]) return { rest: [], query };
	const host = parts[1];
	if (parts[2] === "x" && parts[3]) return { host, term: parts[3], rest: [], query };
	const thread = parts[2] === "t" ? parts[3] : undefined;
	return { host, thread, entry: query.get("e") ?? undefined, panel: query.get("p") ?? undefined, rest: [], query };
}

/** Hrefs for every place in the GUI; components link with these, never with hand-built hashes. */
export const href = {
	thread(host: string, thread: string, opts: { entry?: string; panel?: string } = {}): string {
		const q = new URLSearchParams();
		if (opts.entry) q.set("e", opts.entry);
		if (opts.panel) q.set("p", opts.panel);
		const qs = q.toString();
		return `#/h/${encodeURIComponent(host)}/t/${encodeURIComponent(thread)}${qs ? `?${qs}` : ""}`;
	},
	page(page: string, rest: string[] = [], query: Record<string, string | undefined> = {}): string {
		const q = new URLSearchParams(Object.entries(query).filter((kv): kv is [string, string] => kv[1] !== undefined));
		const qs = q.toString();
		return `#/v/${[page, ...rest].map(encodeURIComponent).join("/")}${qs ? `?${qs}` : ""}`;
	},
	/** A Session or entry citation, `<host>/pi:<sessionId>[#<entryId>]` (K5.I3), as a place in the GUI. */
	ref(ref: string, opts: { panel?: string } = {}): string | undefined {
		const parsed = parseRef(ref);
		return parsed ? href.thread(parsed.host, parsed.thread, { entry: parsed.entry, ...opts }) : undefined;
	},
};

export function parseRef(ref: string): { host: string; thread: string; entry?: string } | undefined {
	const m = /^([^/#]+)\/([^#]+?)(?:#(.+))?$/.exec(ref);
	return m ? { host: m[1]!, thread: m[2]!, entry: m[3] } : undefined;
}

export function goTerm(host: string, termId: string): void {
	navigate(`#/h/${encodeURIComponent(host)}/x/${encodeURIComponent(termId)}`);
}

export function go(host?: string, thread?: string, opts: { entry?: string; panel?: string } = {}): void {
	if (thread) perfMark("switch-start");
	navigate(host ? (thread ? href.thread(host, thread, opts) : `#/h/${encodeURIComponent(host)}`) : "#/");
}
