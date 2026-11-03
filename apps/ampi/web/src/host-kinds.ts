// Host source kinds: what the GUI knows about each source of Sessions without drawing it. Pure, so routes, labels and
// node tests read it. Main registers PI_KIND; another line registers its kinds in extensions.ts. The UI slots of a kind
// are in shell-slots.tsx.

import type { HostState } from "../../src/shared/hosts.ts";
import { isPiThreadId } from "../../src/shared/protocol.ts";
import { hostKinds } from "./extensions.ts";

export interface HostKind {
	/** The link key suffix (`<id>#pi`) and the kind's key in every registry. */
	source: string;
	/** The label suffix when two sources share one Host ID: `devbox · Pi in Herdr`. */
	sourceLabel: string;
	matches(host: Pick<HostState, "kind">): boolean;
	/** The thread ID names its source, so a thread route resolves by Host ID and thread ID only. */
	ownsThread(id: string): boolean;
	/** Herdr runs its Sessions: new agent in Herdr, Resume, Close pane, a read-only composer. */
	herdr: boolean;
	/** It serves the Pi-shaped HostOps and reader views: Find, search, Rarebit, Arc, Timeline and history pages. */
	reader: boolean;
	/**
	 * The prefix a Session citation (`<host>/<prefix><threadId>`) puts before the thread ID, so a citation names the
	 * source. Pi's thread IDs name it already (`pi:`), so Pi has none.
	 */
	citation?: string;
	/** New work prefers this kind: New agent picks it over another source of the same Host. */
	preferNew?: boolean;
}

export const PI_KIND: HostKind = {
	source: "pi",
	sourceLabel: "Pi in Herdr",
	matches: (host) => host.kind === "pi-local" || host.kind === "pi-ssh",
	ownsThread: isPiThreadId,
	herdr: true,
	reader: true,
};

/** Every kind in visible order: PI_KIND first, then each registered kind in registration order. */
export function kinds(): readonly HostKind[] {
	return [PI_KIND, ...hostKinds];
}

/** The kind of a Host; a Host no registered kind matches is Pi's, the kind main's hub serves. */
export function hostKind(host: Pick<HostState, "kind"> | undefined): HostKind {
	return (host && kinds().find((kind) => kind.matches(host))) || PI_KIND;
}

/** The kind that owns a thread ID; undefined when no registered kind does, as for a thread of another release. */
export function kindOfThread(id: string): HostKind | undefined {
	return kinds().find((kind) => kind.ownsThread(id));
}

export function isPiHost(host: Pick<HostState, "kind"> | undefined): boolean {
	return host !== undefined && hostKind(host).herdr;
}

export function servesHostOps(host: Pick<HostState, "kind"> | undefined): boolean {
	return host !== undefined && hostKind(host).reader;
}

/** The kind of a link key's source suffix (`devbox#pi`); undefined for a Host ID or an unknown suffix. */
export function kindOfLink(key: string): HostKind | undefined {
	const at = key.lastIndexOf("#");
	return at < 0 ? undefined : kinds().find((kind) => kind.source === key.slice(at + 1));
}

/** The Host ID of a link key (`devbox#pi`) or of a Host ID: it strips any registered source suffix. */
export function hostIdOf(key: string): string {
	const at = key.lastIndexOf("#");
	return at >= 0 && kinds().some((kind) => kind.source === key.slice(at + 1)) ? key.slice(0, at) : key;
}
