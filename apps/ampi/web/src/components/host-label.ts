import type { HostState } from "../../../src/shared/hosts.ts";
import { isPiThreadId } from "../../../src/shared/protocol.ts";

type Labelled = Pick<HostState, "id" | "label" | "kind">;

/**
 * The Host a route names: its link key (`<id>#pi`) or its Host ID. A thread route names its Host by Host ID only and
 * resolves only for a Pi thread ID; a durable thread ID, as an old pin names, has no source here.
 */
export function findHost<H extends { id: string; link: string }>(hosts: readonly H[], key: string | undefined, thread?: string): H | undefined {
	if (key === undefined) return undefined;
	if (thread !== undefined) return isPiThreadId(thread) ? hosts.find((h) => h.id === key) : undefined;
	return hosts.find((h) => h.link === key) ?? hosts.find((h) => h.id === key);
}

/**
 * The label of a Host wherever the owner sees it: dialogs, the sidebar header, Overview, Find, panels and
 * notifications. `key` is a link key or a Host ID; a key that names no listed Host shows its Host ID.
 */
export function hostLabelFor(key: string, hosts: readonly (Labelled & { link: string })[]): string {
	return findHost(hosts, key)?.label ?? key.replace(/#[^#]*$/, "");
}
