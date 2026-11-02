// The GUI's routes as data: parse, canonicalize and build hashes. Pure, so nav.ts and util.ts both read it
// without importing each other; navigation itself lives in nav.ts.

import { threadSource } from "../../src/shared/protocol.ts";

/**
 * The GUI's one address space (docs/one-gui-views.md, "Links"):
 * - `#/h/<host>/t/<thread>?e=<entry>&p=<panel>`: a Session, optionally scrolled to one entry, with a side panel open;
 * - `#/v/<page>/<rest…>?<query>`: a page (Chief of Staff Timeline).
 */
export type Route = { host?: string; thread?: string; entry?: string; panel?: string; page?: string; rest: string[]; query: URLSearchParams };

/**
 * The Host name in a route. One Session has one route, so a thread route names its Host by Host ID: a link key's source
 * suffix (`devbox#pi`) adds nothing there, because the thread ID picks the source (threadSource in
 * src/shared/protocol.ts), and findHost and the hub's Hub.route resolve the Host ID by it. A route without a thread (a
 * Host) keeps the link key: there a Host ID can name two sources.
 */
function routeHost(host: string, thread: string | undefined): string {
	return thread === undefined ? host : host.replace(/#(pi|durable)$/, "");
}

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
	return { host: routeHost(parts[1], thread), thread, entry: query.get("e") ?? undefined, panel: query.get("p") ?? undefined, rest: [], query };
}

/** `hash` with a thread route's Host named by Host ID; an older link-key form (`#/h/devbox%23pi/t/…`) reads the same. */
export function canonicalRoute(hash: string): string {
	const m = /^#\/h\/([^/?]+)\/t\/([^/?]+)(.*)$/.exec(hash);
	if (!m) return hash;
	// A hash with a malformed escape (`%E0%A4`) names no Session; navigation keeps it as typed.
	try {
		return `#/h/${encodeURIComponent(routeHost(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)))}/t/${m[2]}${m[3]}`;
	} catch {
		return hash;
	}
}

/** Hrefs for every place in the GUI; components link with these, never with hand-built hashes. */
export const href = {
	thread(host: string, thread: string, opts: { entry?: string; panel?: string } = {}): string {
		const q = new URLSearchParams();
		if (opts.entry) q.set("e", opts.entry);
		if (opts.panel) q.set("p", opts.panel);
		const qs = q.toString();
		return `#/h/${encodeURIComponent(routeHost(host, thread))}/t/${encodeURIComponent(thread)}${qs ? `?${qs}` : ""}`;
	},
	page(page: string, rest: string[] = [], query: Record<string, string | undefined> = {}): string {
		const q = new URLSearchParams(Object.entries(query).filter((kv): kv is [string, string] => kv[1] !== undefined));
		const qs = q.toString();
		return `#/v/${[page, ...rest].map(encodeURIComponent).join("/")}${qs ? `?${qs}` : ""}`;
	},
	/**
	 * A Session or entry citation as a place in the GUI: `<host>/pi:<sessionId>[#<entryId>]` (K5.I3) opens the Pi
	 * source of the Host, and `<host>/pi-durable:<threadId>[#<entryId>]` its durable source.
	 */
	ref(ref: string, opts: { panel?: string } = {}): string | undefined {
		const parsed = parseRef(ref);
		if (!parsed) return undefined;
		const durable = parsed.thread.startsWith(DURABLE_HARNESS);
		return href.thread(parsed.host, durable ? parsed.thread.slice(DURABLE_HARNESS.length) : parsed.thread, { entry: parsed.entry, ...opts });
	},
};

const DURABLE_HARNESS = "pi-durable:";

/**
 * The Session citation of a thread on a Host source (`<id>#pi`, `<id>#durable`), as views write `ref`. A bare Host ID,
 * as a thread route names it, picks the source by the thread ID (threadSource), so a route maps back to its citation.
 */
export function threadRef(link: string, threadId: string): string {
	const at = link.lastIndexOf("#");
	const host = at < 0 ? link : link.slice(0, at);
	const durable = (at < 0 ? threadSource(threadId) : link.slice(at + 1)) === "durable";
	return durable ? `${host}/${DURABLE_HARNESS}${threadId}` : `${host}/${threadId}`;
}

export function parseRef(ref: string): { host: string; thread: string; entry?: string } | undefined {
	const m = /^([^/#]+)\/([^#]+?)(?:#(.+))?$/.exec(ref);
	return m ? { host: m[1]!, thread: m[2]!, entry: m[3] } : undefined;
}
