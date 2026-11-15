// The GUI's routes as data: parse and build hashes. Pure, so nav.ts and util.ts both read it
// without importing each other; navigation itself lives in nav.ts.

import { hostIdOf, kindOfLink, kindOfThread, kinds } from "./host-kinds.ts";

/**
 * The GUI's one address space (docs/one-gui-views.md, "Links"):
 * - `#/h/<host>/t/<thread>?e=<entry>&p=<panel>`: a Session, optionally scrolled to one entry, with a side panel open;
 * - `#/v/<page>/<rest…>?<query>`: a page (Chief of Staff Timeline).
 */
export type Route = { host?: string; thread?: string; entry?: string; panel?: string; page?: string; rest: string[]; query: URLSearchParams };

/**
 * The Host ID of a link key (`devbox#pi`) or of a Host ID. One Session has one route, so a thread route names its Host
 * by Host ID; findHost resolves it with the thread ID. A route without a thread keeps the link key: there a Host ID can
 * name two sources.
 */
const hostId = hostIdOf;

export function parseRoute(hash: string): Route {
	const [path = "", search = ""] = hash.replace(/^#/, "").split("?");
	const query = new URLSearchParams(search);
	let parts: string[];
	try {
		parts = path.split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		// A malformed escape (`%E0%A4`) names nothing; the App shows the Overview.
		return { page: "overview", rest: [], query };
	}
	if (parts[0] === "v" && parts[1]) return { page: parts[1], rest: parts.slice(2), query };
	if (parts[0] !== "h" || !parts[1]) return { rest: [], query };
	const thread = parts[2] === "t" ? parts[3] : undefined;
	return { host: parts[1], thread, entry: query.get("e") ?? undefined, panel: query.get("p") ?? undefined, rest: [], query };
}

/** Hrefs for every place in the GUI; components link with these, never with hand-built hashes. */
export const href = {
	thread(host: string, thread: string, opts: { entry?: string; panel?: string } = {}): string {
		const q = new URLSearchParams();
		if (opts.entry) q.set("e", opts.entry);
		if (opts.panel) q.set("p", opts.panel);
		const qs = q.toString();
		return `#/h/${encodeURIComponent(hostId(host))}/t/${encodeURIComponent(thread)}${qs ? `?${qs}` : ""}`;
	},
	page(page: string, rest: string[] = [], query: Record<string, string | undefined> = {}): string {
		const q = new URLSearchParams(Object.entries(query).filter((kv): kv is [string, string] => kv[1] !== undefined));
		const qs = q.toString();
		return `#/v/${[page, ...rest].map(encodeURIComponent).join("/")}${qs ? `?${qs}` : ""}`;
	},
	/**
	 * A Session or entry citation, `<host>/pi:<sessionId>[#<entryId>]` (K5.I3), as a place in the GUI. A kind with a
	 * citation prefix (HostKind.citation) names its source there; the route drops it.
	 */
	ref(ref: string, opts: { panel?: string } = {}): string | undefined {
		const parsed = parseRef(ref);
		if (!parsed) return undefined;
		const prefix = kinds().find((kind) => kind.citation && parsed.thread.startsWith(kind.citation))?.citation ?? "";
		return href.thread(parsed.host, parsed.thread.slice(prefix.length), { entry: parsed.entry, ...opts });
	},
};

/**
 * The Session citation of a thread on a Host source, as views write `ref`. A link key's suffix names the source; a bare
 * Host ID, as a thread route names it, picks the source by the thread ID (HostKind.ownsThread).
 */
export function threadRef(link: string, threadId: string): string {
	const kind = kindOfLink(link) ?? kindOfThread(threadId);
	return `${hostIdOf(link)}/${kind?.citation ?? ""}${threadId}`;
}

export function parseRef(ref: string): { host: string; thread: string; entry?: string } | undefined {
	const m = /^([^/#]+)\/([^#]+?)(?:#(.+))?$/.exec(ref);
	return m ? { host: m[1]!, thread: m[2]!, entry: m[3] } : undefined;
}
