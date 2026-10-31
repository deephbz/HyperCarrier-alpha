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

/**
 * The projection every view renders for a Host's link: what the link does and for how long, its last failure, and the
 * next step. Views show all three for a Host that is not connected, so a retry never hides why it is not connected.
 */
export type LinkView = { state: string; error?: string; hint?: string };

export function linkView(host: HostState, now = Date.now()): LinkView {
	if (host.status === "connected") return { state: "connected" };
	const notes = { ...(host.error ? { error: host.error } : {}), ...(host.hint ? { hint: host.hint } : {}) };
	if (host.status === "connecting") {
		const elapsed = duration(now - host.since);
		return { state: `connecting · ${host.phase === "hello" ? "awaiting hello" : "opening link"}${elapsed ? ` · ${elapsed}` : ""}`, ...notes };
	}
	const retry = host.retryAt ? duration(host.retryAt - now) : "";
	return { state: `away${host.lastSeen ? ` · seen ${ago(host.lastSeen, now)} ago` : ""}${retry ? ` · retry in ${retry}` : ""}`, ...notes };
}

/** Seconds below two minutes, then minutes. */
function duration(ms: number): string {
	if (!Number.isFinite(ms)) return "";
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** Overview's line for a Host that is not connected: its link state, last failure, and next step. */
export function linkLine(view: LinkView): string {
	return [view.state, view.error, view.hint].filter(Boolean).join(" — ");
}

/** The sidebar header's quiet status. A connected Host shows only its green dot; screen readers still hear "connected". */
export function hostMeta(host: HostState, now = Date.now()): string {
	return host.status === "connected" ? "" : host.status === "connecting" ? linkView(host, now).state : "away";
}
