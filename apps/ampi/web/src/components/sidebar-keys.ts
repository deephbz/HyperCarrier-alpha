import { isEditableTarget } from "../keymap.ts";

export type SidebarKeyAction = "previous" | "next" | "first" | "last" | "collapse" | "parent" | "expand" | "child" | "open" | undefined;

export function sidebarKeyAction(key: string, expanded: boolean, expandable: boolean, hasParent: boolean): SidebarKeyAction {
	if (key === "j") return "next";
	if (key === "k") return "previous";
	if (key === "g") return "first";
	if (key === "G") return "last";
	if (key === "Enter") return "open";
	if (key === "h") return expanded ? "collapse" : hasParent ? "parent" : undefined;
	if (key === "l") return expandable ? expanded ? "child" : "expand" : undefined;
	return undefined;
}

/** Handles the sidebar's roving rows. Global and editable-target keys remain owned by their existing handlers. */
export function handleSidebarKeyDown(event: KeyboardEvent, root: HTMLElement): void {
	const allowShiftG = event.key.toLowerCase() === "g" && event.shiftKey;
	if (event.metaKey || event.ctrlKey || event.altKey || (event.shiftKey && !allowShiftG) || isEditableTarget(event.target)) return;
	const key = allowShiftG ? "G" : event.key;
	const rows = [...root.querySelectorAll<HTMLElement>("[data-nav-row]")].filter((row) => row.getClientRects().length > 0);
	if (!rows.length) return;
	const closestRow = (target: EventTarget | null) => target instanceof HTMLElement
		? target.closest<HTMLElement>("[data-nav-row]") ?? target.closest<HTMLElement>(".row")?.querySelector<HTMLElement>("[data-nav-row]")
		: null;
	const current = closestRow(event.target);
	const row = current && root.contains(current) ? current : closestRow(document.activeElement);
	if (!row || !root.contains(row)) return;
	const container = row.matches(".row") ? row : row.closest<HTMLElement>(".row") ?? row;
	const id = row.dataset.navId ?? row.dataset.leaderRow;
	const parentId = row.dataset.parentLeader ?? row.dataset.parentNavId;
	const hostSection = row.closest<HTMLElement>("[data-host]");
	const sameHost = (item: HTMLElement) => !hostSection || item.closest("[data-host]") === hostSection;
	const expandControl = container.matches("[data-sidebar-toggle]")
		? container
		: container.querySelector<HTMLElement>("[data-collapse-toggle], [data-sidebar-toggle]");
	const expanded = row.getAttribute("aria-expanded") === "true" || container.getAttribute("aria-expanded") === "true" || expandControl?.getAttribute("aria-expanded") === "true";
	const action = sidebarKeyAction(key, expanded, Boolean(expandControl), Boolean(parentId));
	if (!action) return;
	const focus = (target: HTMLElement | undefined) => {
		if (!target) return;
		for (const item of rows) item.tabIndex = item === target ? 0 : -1;
		target.focus();
		event.preventDefault();
		event.stopPropagation();
	};
	switch (action) {
		case "previous": focus(rows[Math.max(0, rows.indexOf(row) - 1)]); break;
		case "next": focus(rows[Math.min(rows.length - 1, rows.indexOf(row) + 1)]); break;
		case "first": focus(rows[0]); break;
		case "last": focus(rows.at(-1)); break;
		case "parent": {
			const leader = rows.find((item) => sameHost(item) && (item.dataset.navId ?? item.dataset.leaderRow) === parentId);
			focus(leader);
			break;
		}
		case "collapse":
		case "expand":
			if (expandControl) {
				expandControl.click();
				event.preventDefault();
				event.stopPropagation();
			}
			break;
		case "child": {
			const child = rows.find((item) => sameHost(item) && (item.dataset.parentLeader ?? item.dataset.parentNavId) === id);
			focus(child);
			break;
		}
		case "open": {
			const link = row.querySelector<HTMLElement>("a[href]");
			if (link) link.click(); else row.click();
			event.preventDefault();
			event.stopPropagation();
			break;
		}
	}
}
