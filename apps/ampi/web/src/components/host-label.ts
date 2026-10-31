import type { HostState } from "../../../src/hub/hosts.ts";

export function isPiHost(host: Pick<HostState, "kind"> | undefined): boolean {
	return host?.kind === "pi-local" || host?.kind === "pi-ssh";
}

/**
 * The label of a Host wherever the owner sees it: dialogs, the sidebar header, Overview, Find, Arcs, panels and
 * notifications. When two Host sources share one Host ID (Pi and a durable node on one machine), each label names its
 * source; otherwise the label is the Host's own. `hosts` is every Host the hub serves, not only the ones on screen.
 */
type Labelled = Pick<HostState, "id" | "label" | "kind">;

export function hostLabel(host: Labelled, hosts: readonly Labelled[]): string {
	const shared = hosts.filter((other) => other.id === host.id).length > 1;
	return shared ? `${host.label} · ${isPiHost(host) ? "Pi in Herdr" : "durable"}` : host.label;
}

/**
 * The Host source a route names: its link key, or a Host ID that one source serves. When two sources serve the Host
 * ID, a thread ID names the source: `pi:` for Pi, any other for durable.
 */
export function findHost<H extends { id: string; link: string }>(hosts: readonly H[], key: string | undefined, thread?: string): H | undefined {
	if (key === undefined) return undefined;
	const exact = hosts.find((h) => h.link === key);
	if (exact) return exact;
	const byId = hosts.filter((h) => h.id === key);
	if (byId.length === 1) return byId[0];
	if (thread === undefined) return undefined;
	const source = thread.startsWith("pi:") ? "pi" : "durable";
	return byId.find((h) => h.link === `${key}#${source}`);
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
