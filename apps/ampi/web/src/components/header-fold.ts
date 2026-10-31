import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { scaleOf } from "../display.ts";

/**
 * The Session header's one composition rule. The header is a FormRow: the Session name is its field and keeps
 * `--field-min` (FormRow owns that reserve). This hook owns where the secondary actions go. They stay in the bar while
 * every action shares the name's line, and move into More as soon as one would leave it. FormRow's wrap is then only a
 * last resort, for a row too narrow even for the name and the primary actions. No width is named here: the rule reads
 * the drawn row, at any viewport, zoom, pointer or set of badges.
 *
 * `group` holds the secondary actions, inside the FormRow's actions. While folded it stays drawn but invisible and out of flow (`data-folded`), so its
 * width is still known. Unfolding needs the name's spare width above its minimum to hold that group; folding needs an
 * action off the name's line. Folding never adds more width than it removes, so neither state can lead back to the
 * other at one width.
 */
export function useHeaderFold(group: RefObject<HTMLElement | null>): boolean {
	const [folded, setFolded] = useState(false);
	const now = useRef(folded);
	now.current = folded;
	const check = useCallback(() => {
		const g = group.current, r = g?.closest<HTMLElement>(".form-row");
		if (!g || !r) return;
		const next = foldsAt(r, g, now.current);
		if (next !== now.current) setFolded((now.current = next));
	}, [group]);
	// Before the first paint, then on every size change of the row, the name, the actions and the folded group.
	useLayoutEffect(check, [check]);
	useEffect(() => {
		const g = group.current, r = g?.closest<HTMLElement>(".form-row");
		if (!g || !r) return;
		const observer = new ResizeObserver(check);
		for (const el of [r, g, r.querySelector(":scope > .form-field"), r.querySelector(":scope > .form-actions")]) if (el) observer.observe(el);
		return () => observer.disconnect();
	}, [check, group]);
	return folded;
}

function foldsAt(row: HTMLElement, group: HTMLElement, folded: boolean): boolean {
	const field = row.querySelector<HTMLElement>(":scope > .form-field"), actions = row.querySelector<HTMLElement>(":scope > .form-actions");
	if (!field || !actions || !group.firstElementChild) return false;
	const name = field.getBoundingClientRect();
	const onLine = [...actions.children].every((el) => {
		if (folded && el === group) return true;
		const box = el.getBoundingClientRect();
		return box.width === 0 || (box.top < name.bottom && box.bottom > name.top);
	});
	if (!folded) return !onLine;
	if (!onLine) return true;
	// FormRow's field grows into all free width; its flex basis is the --field-min reserve in the field's own CSS px.
	const min = Number.parseFloat(getComputedStyle(field).flexBasis) * scaleOf(field);
	const gap = (Number.parseFloat(getComputedStyle(actions).columnGap) || 0) * scaleOf(actions);
	if (!Number.isFinite(min)) return true;
	return name.width - min < group.getBoundingClientRect().width + gap + 1;
}
