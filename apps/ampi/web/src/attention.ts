// Attention routing (the Herdr role AmPi takes over): when a thread starts needing the owner or a top-level run
// settles while the owner is elsewhere, raise one notification that opens the thread; keep the needs-you count on the
// Dock badge (macOS shell) or the tab title (browser). Only transitions notify, never the initial state.
import { useEffect, useRef } from "react";
import type { ThreadSummary } from "../../src/shared/protocol.ts";
import type { HostThreads } from "./components/Sidebar.tsx";
import { go, isBusy, needsYou } from "./util.ts";

type Native = { postMessage(message: unknown): void };
function native(): Native | undefined {
	return (window as unknown as { webkit?: { messageHandlers?: { ampi?: Native } } }).webkit?.messageHandlers?.ampi;
}

export function notify(title: string, body: string, host: string, threadId: string): void {
	const shell = native();
	if (shell) {
		shell.postMessage({ type: "notify", title, body, route: `#/h/${encodeURIComponent(host)}/t/${encodeURIComponent(threadId)}` });
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
	location.hash = route;
};

export function useAttention(data: HostThreads[], current?: { host?: string; thread?: string }): void {
	const previous = useRef<Map<string, ThreadSummary> | undefined>(undefined);
	useEffect(() => {
		const now = new Map<string, ThreadSummary>();
		let count = 0;
		for (const { host, threads } of data)
			for (const t of threads) {
				now.set(`${host.id}|${t.id}`, t);
				if (!t.archived && needsYou(t)) count++;
			}
		setBadge(count);
		const before = previous.current;
		previous.current = now;
		if (!before) return;
		const away = document.hidden || !document.hasFocus();
		for (const { host, threads } of data)
			for (const t of threads) {
				const was = before.get(`${host.id}|${t.id}`);
				if (!was || t.archived) continue;
				const viewing = !away && current?.host === host.id && current.thread === t.id;
				if (viewing) continue;
				const reason = needsYou(t);
				if (reason && reason !== needsYou(was)) notify(`Needs you: ${t.title}`, `${host.label} · ${reason}${t.lastError ? ` — ${t.lastError}` : ""}`, host.id, t.id);
				else if (away && isBusy(was) && !isBusy(t) && t.kind !== "worker" && !reason)
					notify(`Finished: ${t.title}`, `${host.label} · ${t.preview ?? "the agent settled"}`, host.id, t.id);
			}
	}, [data, current?.host, current?.thread]);
}
