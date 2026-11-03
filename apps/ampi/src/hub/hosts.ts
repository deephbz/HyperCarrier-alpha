// Host link status helpers and route keys, shared by the hub and its Pi Hosts.

import type { LinkPhase, LinkStatus, HostBase, HostState } from "../shared/hosts.ts";

const STATUS_KEYS = ["status", "connectedAt", "since", "phase", "hint", "error", "retryAt"] as const;

/** `state` with its status replaced by `next`: no field of the old status outlives it. */
export function withStatus(state: HostState, next: LinkStatus): HostState {
	const base: Record<string, unknown> = { ...state };
	for (const key of STATUS_KEYS) delete base[key];
	return { ...(base as HostBase), ...next };
}

/** A negotiating status that keeps the last failure, so a retry never hides why the link is not connected. */
export function negotiating(state: HostState, phase: LinkPhase, hint: string, now = Date.now()): LinkStatus {
	return { status: "connecting", phase, since: now, hint, ...(state.error ? { error: state.error } : {}) };
}

/** The route key of a Host's Pi source. */
export function linkKey(config: { id: string }): string {
	return `${config.id}#pi`;
}
