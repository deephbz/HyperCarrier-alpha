import type { HostState } from "../../../src/shared/hosts.ts";
import { hostKind, kindOfThread } from "../host-kinds.ts";

export { isPiHost, servesHostOps } from "../host-kinds.ts";

type Labelled = Pick<HostState, "id" | "label" | "kind">;

/**
 * The label of a Host wherever the owner sees it: dialogs, the sidebar header, Overview, Find, panels and
 * notifications. When two Host sources share one Host ID, each label names its source (HostKind.sourceLabel);
 * otherwise the label is the Host's own. `hosts` is every Host the hub serves, not only the ones on screen.
 */
export function hostLabel(host: Labelled, hosts: readonly Labelled[]): string {
	const shared = hosts.filter((other) => other.id === host.id).length > 1;
	return shared ? `${host.label} · ${hostKind(host).sourceLabel}` : host.label;
}

/**
 * The Host source a route names. A thread route names its Host by Host ID only, and the thread ID names its source
 * (HostKind.ownsThread), so it resolves only to that source; a thread no registered kind owns, as an old pin names,
 * has no source here. Without a thread, a link key resolves exactly, and a Host ID resolves when one source serves it.
 */
export function findHost<H extends { id: string; link: string }>(hosts: readonly H[], key: string | undefined, thread?: string): H | undefined {
	if (key === undefined) return undefined;
	const byId = hosts.filter((h) => h.id === key);
	if (thread !== undefined) {
		const kind = kindOfThread(thread);
		return kind && byId.find((h) => h.link === `${key}#${kind.source}`);
	}
	return hosts.find((h) => h.link === key) ?? (byId.length === 1 ? byId[0] : undefined);
}

/**
 * The label for a route key: a link key (`<id>#pi`) or a bare Host ID. The owner never sees the link key: a key that
 * names no listed Host shows its Host ID, whatever source the key names.
 */
export function hostLabelFor(key: string, hosts: readonly (Labelled & { link: string })[]): string {
	const host = findHost(hosts, key);
	return host ? hostLabel(host, hosts) : key.replace(/#[^#]*$/, "");
}
