// Attention routing (the Herdr role AmPi takes over): when a thread starts needing the owner or a top-level run
// settles while the owner is elsewhere, raise one notification that opens the thread; keep the needs-you count on the
// Dock badge (macOS shell) or the tab title (browser). Only transitions notify, never the initial state.
import { useEffect, useRef } from "react";
import type { ThreadSummary } from "../../src/shared/protocol.ts";
import type { HostThreads } from "./components/Sidebar.tsx";
import { native } from "./native.ts";
import { navigate } from "./nav.ts";
import { attentionOf, go, href, isAttentionEligible, isBusy, needsYou, openAsks } from "./util.ts";


export function notify(title: string, body: string, host: string, threadId: string): void {
	const shell = native();
	if (shell) {
		shell.postMessage({ type: "notify", title, body, tag: `${host}|${threadId}`, route: href.thread(host, threadId) });
		return;
	}
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
	const n = new Notification(title, { body, tag: `${host}|${threadId}` });
	n.onclick = () => {
		window.focus();
		go(host, threadId);
	};
}

/** Ask for browser notification permission once, on a user gesture. */
export function requestNotificationPermission(): void {
	if (native() || typeof Notification === "undefined" || Notification.permission !== "default") return;
	void Notification.requestPermission();
}

function setBadge(count: number): void {
	const shell = native();
	if (shell) shell.postMessage({ type: "badge", count });
	document.title = count > 0 ? `(${count}) AmPi` : "AmPi";
}

/** Window navigation from the shell (notification click): `window.ampiOpen("#/h/…")`. */
(window as unknown as { ampiOpen: (route: string) => void }).ampiOpen = (route) => {
	navigate(route);
};

export function needsYouCount(data: HostThreads[]): number {
	return data.reduce((count, { threads }) => count + threads.filter((t) => needsYou(t)).length, 0);
}

export function useAttention(data: HostThreads[], current?: { host?: string; thread?: string }): void {
	const previous = useRef<Map<string, ThreadSummary> | undefined>(undefined);
	useEffect(() => {
		const now = new Map<string, ThreadSummary>();
		for (const { host, threads } of data)
			for (const t of threads) now.set(`${host.link}|${t.id}`, t);
		setBadge(needsYouCount(data));
		const before = previous.current;
		previous.current = now;
		if (!before) return;
		const away = document.hidden || !document.hasFocus();
		for (const n of notices(before, data, current, away)) notify(n.title, n.body, n.host, n.threadId);
	}, [data, current?.host, current?.thread]);
}

/** The notifications one thread-list update raises against the previous one: transitions only, never the initial state. */
export function notices(before: Map<string, ThreadSummary>, data: HostThreads[], current: { host?: string; thread?: string } | undefined, away: boolean): { title: string; body: string; host: string; threadId: string }[] {
	const out: { title: string; body: string; host: string; threadId: string }[] = [];
	const hosts = data.map((d) => d.host);
	for (const { host, threads } of data)
		for (const t of threads) {
			const was = before.get(`${host.link}|${t.id}`);
			// History raises neither Needs you nor Finished notifications.
			if (!was || !isAttentionEligible(t)) continue;
			const viewing = !away && current?.host === host.link && current?.thread === t.id;
			if (viewing) continue;
			const reason = needsYou(t);
			if (reason && (newSignal(was, t) || asksGrew(was, t))) out.push({ title: `Needs you: ${t.title}`, body: `${host.label} · ${reason}${t.lastError ? ` — ${t.lastError}` : ""}`, host: host.link, threadId: t.id });
			else if (away && isBusy(was) && !isBusy(t) && t.kind !== "worker" && !reason)
				out.push({ title: `Finished: ${t.title}`, body: `${host.label} · ${t.preview ?? "the agent settled"}`, host: host.link, threadId: t.id });
		}
	return out;
}

/** A live signal, by source and reason, that the previous list did not show. A cleared signal is never new. */
function newSignal(was: ThreadSummary, t: ThreadSummary): boolean {
	const key = (a: { source: string; reason: string }) => `${a.source}\u0000${a.reason}`;
	const before = new Set(attentionOf(was).map(key));
	return attentionOf(t).some((a) => !before.has(key(a)));
}

/** An Arc ask count grew or a new ask kind appeared. A shrink resolves an ask and stays silent. */
function asksGrew(was: ThreadSummary, t: ThreadSummary): boolean {
	const before = new Map(openAsks(was).map((a) => [a.kind, a.n]));
	return openAsks(t).some((a) => a.n > (before.get(a.kind) ?? 0));
}
