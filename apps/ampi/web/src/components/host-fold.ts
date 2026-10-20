import type { HostState } from "../../../src/hub/hosts.ts";
import { ago } from "../util.ts";

/**
 * One Host's saved sidebar fold. Folding only collapses the Host group and its error; it never acknowledges an away
 * Host, so the dot, the header and Overview read the same folded or not.
 */
export type HostFold = { collapsed: boolean };

export const hostFoldKey = (id: string) => `ampi.sidebar.hostCollapsed.${id}`;

export function readHostFold(id: string): HostFold {
	try {
		// A fold saved by an older build also carries its away record; only `collapsed` is read.
		const saved = JSON.parse(localStorage.getItem(hostFoldKey(id)) ?? "null") as Partial<HostFold> | null;
		if (saved && typeof saved.collapsed === "boolean") return { collapsed: saved.collapsed };
	} catch { /* Open by default if storage is unavailable or invalid. */ }
	return { collapsed: false };
}

export function saveHostFold(host: Pick<HostState, "id">, collapsed: boolean): HostFold {
	const fold: HostFold = { collapsed };
	try { localStorage.setItem(hostFoldKey(host.id), JSON.stringify(fold)); } catch { /* The fold holds for this page only. */ }
	return fold;
}

/** Overview's line for a disconnected Host, with its error. */
export function awayLine(host: HostState): string {
	return `disconnected${host.lastSeen ? `, last seen ${ago(host.lastSeen)} ago` : ""}${host.error ? ` — ${host.error}` : ""}`;
}

/** The sidebar header's quiet status word. */
export function hostMeta(host: HostState): string {
	return host.status === "connected" ? "live" : host.status === "connecting" ? "connecting…" : "away";
}
