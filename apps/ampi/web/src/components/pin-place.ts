// Where a pinned Session opens (Pinned.tsx). A pin names a Session by threadId alone (src/hub/pins.ts); its host is a
// hint: the route key (HostState `link`, such as "devbox" or "devbox#pi") that last listed it. Pure, so tests can check
// it without a browser.

import type { Pin, ThreadSummary } from "../../../src/shared/protocol.ts";

/** The part of a Host's sidebar state that resolving needs (Sidebar.tsx HostThreads). */
export type PinHost = { host: { id: string; link: string; label?: string }; threads: ThreadSummary[]; stale: boolean; listing?: boolean; indexing?: boolean };
export type Listed = { host: string; label: string; t: ThreadSummary };

export const settled = (d: PinHost) => !d.stale && !d.listing && !d.indexing;

/**
 * Where a pin opens, from the Hosts' current lists: the hinted Host when it lists the Session; else the one Host that
 * lists it; else a choice when several do. A pin no Host lists is "gone" only once every list is complete.
 */
export function resolvePin(pin: Pin, data: PinHost[]): { listed: Listed[]; target?: Listed; gone: boolean; moveHint: boolean } {
	const listed = data.flatMap((d) => { const t = d.threads.find((x) => x.id === pin.threadId); return t ? [{ host: d.host.link, label: d.host.label || d.host.link, t }] : []; });
	// Two routes to one Host share a label; a choice row then names the routes.
	for (const x of listed) if (listed.some((y) => y !== x && y.label === x.label)) x.label = x.host;
	const hinted = data.find((d) => d.host.link === pin.host);
	const target = listed.find((x) => x.host === pin.host) ?? (listed.length === 1 ? listed[0] : undefined);
	return {
		listed, target,
		gone: !listed.length && data.length > 0 && data.every((d) => !d.listing && !d.indexing) && (!hinted || settled(hinted)),
		// Move the hint only when the hinted Host is gone or its complete list lacks the Session.
		moveHint: !!target && target.host !== pin.host && (!hinted || settled(hinted)),
	};
}

