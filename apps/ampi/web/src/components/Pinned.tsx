// Pinned Sessions in the sidebar, the Pin/Unpin row menu, and the topbar star. The hub owns the list (src/hub/pins.ts).
// A pinned row is a shortcut, not a second copy of the Session row: its nav id has its own namespace, it carries no
// aria-current and no hierarchy level, so arrow keys, the active row and the hierarchy checks still see one row per Session.

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Pin, ThreadSummary } from "../../../src/shared/protocol.ts";
import { resolvePin } from "./pin-place.ts";
import { hintPin, setPin, usePins } from "../client.ts";
import { ago, go, href } from "../util.ts";
import { Popover, at } from "./Popover.tsx";
import { ActivityIcon, type HostThreads } from "./Sidebar.tsx";

// A pin names a Session by threadId alone (src/hub/pins.ts); its host is a hint.
const pinned = (pins: Pin[], threadId: string) => pins.some((p) => p.threadId === threadId);
/** The tree row's label: a team Worker reads with its leader, as the tree shows it under the leader row. */
function rowLabel(t: ThreadSummary, threads: ThreadSummary[]): string {
	if (t.team?.role !== "worker" || !t.team.worker) return t.title || "Untitled Session";
	const lead = threads.find((x) => x.team?.role === "lead" && x.team.teamId === t.team!.teamId);
	return lead ? `${t.team.worker} · ${lead.title || "Untitled Session"}` : t.team.worker;
}

/**
 * Pinned Sessions above the Hosts. The section ignores the sidebar filter. A Session on several Host routes shows one
 * link per Host; one that no Host lists shows its saved title, dimmed, as "Not found on <host>".
 */
export function PinnedSection({ data }: { data: HostThreads[] }) {
	const pins = usePins();
	const places = pins.map((pin) => ({ pin, ...resolvePin(pin, data) }));
	const moved = useRef(new Set<string>());
	useEffect(() => {
		for (const { pin, target, moveHint } of places) {
			const key = `${pin.threadId}>${target?.host}`;
			if (moveHint && target && !moved.current.has(key)) { moved.current.add(key); hintPin(target.host, pin.threadId); }
		}
	});
	if (!pins.length) return null;
	return (
		<div className="nav-section pinned" data-pinned>
			<div className="nav-label">Pinned</div>
			{places.map(({ pin, listed, target, gone }) => {
				const any = target ?? listed[0];
				const title = any ? rowLabel(any.t, data.find((d) => d.host.link === any.host)!.threads) : pin.title || pin.threadId;
				const choice = !target && listed.length > 1;
				return (
					<div key={pin.threadId} className={`row pin-row${gone ? " gone" : ""}${choice ? " choice" : ""}`} data-pin={pin.threadId} onClick={(e) => target && !(e.target as HTMLElement).closest("a, button") && go(target.host, pin.threadId)} title={gone ? `${pin.title || pin.threadId}\nNot found on ${pin.host}` : any ? `${any.t.title}\n${any.t.cwd}` : pin.title}>
						<span className="mark-slot">{any && <ActivityIcon t={any.t} />}</span>
						{choice
							? <span className="title" dir="auto">{title}</span>
							: <a className="title" href={target ? href.thread(target.host, pin.threadId) : undefined} data-nav-row={target ? "" : undefined} data-nav-id={`pin:${pin.threadId}`} tabIndex={-1} dir="auto">{title}</a>}
						{gone ? <span className="sub">Not found on {pin.host}</span> : any && <span className="sub">{ago(any.t.updatedAt)}</span>}
						<button className="pin-x" aria-label={`Unpin ${title}`} title="Unpin" onClick={() => setPin(pin.host, pin.threadId, false)}>×</button>
						{choice && <span className="pin-hosts">{listed.map((x) => <a key={x.host} href={href.thread(x.host, pin.threadId)} data-nav-row data-nav-id={`pin:${pin.threadId}@${x.host}`} tabIndex={-1} title={`Open on ${x.label}`}>{x.label}</a>)}</span>}
					</div>
				);
			})}
		</div>
	);
}

/** The topbar star: shows whether the open Session is pinned; a click sends the state its label offers. */
export function PinStar({ host, threadId, title }: { host: string; threadId: string; title: string }) {
	const on = pinned(usePins(), threadId);
	return (
		<button className={`btn ghost small pin-star${on ? " on" : ""}`} aria-pressed={on} aria-label={on ? "Unpin this Session" : "Pin this Session"} title={on ? "Unpin from the sidebar" : "Pin to the top of the sidebar"} onClick={() => setPin(host, threadId, !on, title)}>
			{on ? "★" : "☆"}
		</button>
	);
}

type Menu = { x: number; y: number; host: string; threadId: string; title: string; row: HTMLElement } | undefined;
let menu: Menu;
const listeners = new Set<() => void>();
const setMenu = (next: Menu) => { menu = next; for (const l of listeners) l(); };

/** Opens the row menu at the pointer, or under the row when the menu key or Shift+F10 opened it. */
export function openPinMenu(event: React.MouseEvent, host: string, threadId: string, title: string): void {
	event.preventDefault();
	const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
	const keyboard = event.clientX === 0 && event.clientY === 0;
	setMenu({ x: keyboard ? box.left + 24 : event.clientX, y: keyboard ? box.bottom : event.clientY, host, threadId, title, row: event.currentTarget as HTMLElement });
}

/**
 * The row menu: one action today (Pin or Unpin), a Popover at the pointer that belongs to its row. Its close policy
 * holds: a scroll in another region, such as the Overview page as Sessions arrive, leaves the row and the menu in place.
 */
export function PinMenu() {
	const m = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => menu);
	const pins = usePins();
	if (!m) return null;
	const on = pinned(pins, m.threadId);
	return (
		<Popover className="t-more-menu row-menu" role="menu" anchor={() => at(m.x, m.y)} owner={m.row} onClose={() => setMenu(undefined)} menu>
			<button role="menuitem" onClick={() => { setPin(m.host, m.threadId, !on, m.title); setMenu(undefined); }}>{on ? "Unpin" : "Pin to top"}</button>
		</Popover>
	);
}
