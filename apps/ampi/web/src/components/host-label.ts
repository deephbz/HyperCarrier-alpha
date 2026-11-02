import type { HostState } from "../../../src/shared/hosts.ts";
import { threadSource } from "../../../src/shared/protocol.ts";

export function isPiHost(host: Pick<HostState, "kind"> | undefined): boolean {
	return host?.kind === "pi-local" || host?.kind === "pi-ssh";
}

/**
 * The Host source serves the Pi-shaped HostOps and reader views: Find, search, Rarebit, Arc, Timeline and history pages.
 * A Pi Host serves them itself; the hub serves them for a durable node from its reader copy (node-design.md, step 8).
 * Herdr-only behavior (new agent in Herdr, Resume, Close pane, a read-only composer) stays behind `isPiHost`.
 */
export function servesHostOps(host: HostState | undefined): boolean {
	return host?.kind === "pi-local" || host?.kind === "pi-ssh" || host?.kind === "local" || host?.kind === "ssh";
}

/**
 * The label of a Host wherever the owner sees it: dialogs, the sidebar header, Overview, Find, panels and
 * notifications. When two Host sources share one Host ID (Pi and a durable node on one machine), each label names its
 * source; otherwise the label is the Host's own. `hosts` is every Host the hub serves, not only the ones on screen.
 */
type Labelled = Pick<HostState, "id" | "label" | "kind">;

export function hostLabel(host: Labelled, hosts: readonly Labelled[]): string {
	const shared = hosts.filter((other) => other.id === host.id).length > 1;
	return shared ? `${host.label} · ${isPiHost(host) ? "Pi in Herdr" : "durable"}` : host.label;
}

/**
 * The Host source a route names: its link key, or a Host ID. A thread ID names its source (threadSource), so a thread
 * route resolves only to that source; without a thread, a Host ID resolves when one source serves it.
 */
export function findHost<H extends { id: string; link: string }>(hosts: readonly H[], key: string | undefined, thread?: string): H | undefined {
	if (key === undefined) return undefined;
	const exact = hosts.find((h) => h.link === key);
	if (exact) return exact;
	const byId = hosts.filter((h) => h.id === key);
	if (thread !== undefined) return byId.find((h) => h.link === `${key}#${threadSource(thread)}`);
	return byId.length === 1 ? byId[0] : undefined;
}

/**
 * The label for a route key: a link key (`<id>#pi`, `<id>#durable`) or a bare Host ID. The owner never sees the link
 * key: a key that names no listed Host shows its Host ID.
 */
export function hostLabelFor(key: string, hosts: readonly (Labelled & { link: string })[]): string {
	const byId = hosts.filter((h) => h.id === key);
	const host = hosts.find((h) => h.link === key) ?? (byId.length === 1 ? byId[0] : undefined);
	return host ? hostLabel(host, hosts) : key.replace(/#(pi|durable)$/, "");
}
