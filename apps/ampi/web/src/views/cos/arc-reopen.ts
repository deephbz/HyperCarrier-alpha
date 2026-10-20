// Whether a Session opens with Arc. Only an explicit show or close of Arc decides it (focus R16, R20, R21); the pane
// width decides it at each Session open. ThreadView calls useArcReopen; App keys ThreadView per Session.

import { useEffect, useRef } from "react";

/** "1" when the owner last showed Arc explicitly: a wide Session reopens it. */
export const ARC_REOPEN_KEY = "ampi.arc.reopen";
/** The panel ⌘L opens. Only ★ in the panel tabs writes it (focus R16). */
export const PANEL_DEFAULT_KEY = "ampi.panel.default";
/** Below this pane width (sidebar excluded) the panel starts collapsed, whatever was saved. */
export const ARC_PANEL_MIN_PANE = 900;

export function rememberArcShown(shown: boolean) {
	localStorage.setItem(ARC_REOPEN_KEY, shown ? "1" : "0");
}

/** The owner closed the named panel (the panel ✕ or ⌘L). Closing Arc there counts as the Arc button off. */
export function panelClosed(name: string) {
	if (name === "arc") rememberArcShown(false);
}

/** Moves former preferences to the reopen key once: the open/closed flag, then a shared panel default of "arc". */
export function migrateArcPreference() {
	const legacy = localStorage.getItem("ampi.arc.panel");
	if (localStorage.getItem(ARC_REOPEN_KEY) === null && (legacy === "open" || localStorage.getItem(PANEL_DEFAULT_KEY) === "arc")) rememberArcShown(true);
	localStorage.removeItem("ampi.arc.panel");
}

/** The panel a Session opens with: a narrow pane collapses a saved Arc; a wide one reopens Arc if the owner last showed it. */
export function panelOnSessionOpen(panel: string | undefined, paneWidth: number): string | undefined {
	const wide = paneWidth >= ARC_PANEL_MIN_PANE;
	if (!wide && panel === "arc") return undefined;
	if (wide && !panel && localStorage.getItem(ARC_REOPEN_KEY) === "1") return "arc";
	return panel;
}

/** The pane beside the sidebar: the transcript plus any open panel. It uses the owner's saved sidebar (App.tsx keys),
 * because an open panel can squeeze the sidebar away and the live DOM would then overstate the pane. */
function paneWidth(): number {
	const sidebar = localStorage.getItem("ampi.sidebar.hidden") === "1" ? 0 : Number(localStorage.getItem("ampi.sidebar.width")) || 280;
	return window.innerWidth - sidebar;
}

/** Applies panelOnSessionOpen once per Session, on the first render where the Session is known to be a Pi Session
 * (the host list can arrive after the first render). `panel` is App's saved panel state: a `?p=` link applies later
 * (App's route effect runs after this child effect) and stays an explicit open, also in a narrow pane. setPanel
 * reports "panel.set", which moves focus only when it was lost (focus.ts), so the reopen keeps focus in place (I20). */
export function useArcReopen(pi: boolean, panel: string | undefined, setPanel: (p?: string) => void) {
	const done = useRef(false);
	useEffect(() => {
		if (!pi || done.current) return;
		done.current = true;
		migrateArcPreference();
		const next = panelOnSessionOpen(panel, paneWidth());
		if (next !== panel) setPanel(next);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pi]);
}
