import { useId, useLayoutEffect, useRef, useState, type DependencyList, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A card that hover or keyboard focus opens beside its anchor. It renders in a body portal at a fixed viewport
 * position, so no container clips it and the layout never shifts. It stays open while the pointer or focus is
 * inside the anchor or the card; Escape closes it. React events from the portal bubble to the anchor.
 */
export function useHoverCard<T extends HTMLElement>({ prefer = "below", deps = [] }: { prefer?: "below" | "above"; deps?: DependencyList } = {}) {
	const id = useId();
	const anchor = useRef<T>(null);
	const card = useRef<HTMLElement>(null);
	const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 800 });
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		if (!open) return;
		const place = () => {
			if (!anchor.current || !card.current) return;
			const rect = anchor.current.getBoundingClientRect();
			const box = card.current.getBoundingClientRect();
			const height = Math.min(card.current.scrollHeight + 2, window.innerHeight - 24);
			const above = Math.max(0, rect.top - 12), below = Math.max(0, window.innerHeight - rect.bottom - 12);
			let left = Math.max(12, Math.min(rect.left, window.innerWidth - box.width - 12));
			let top = rect.bottom, maxHeight = height;
			if (above >= height && (prefer === "above" || below < height)) top = rect.top - height;
			else if (below < height) {
				if (window.innerWidth - rect.right - 12 >= box.width) { left = rect.right; top = Math.max(12, window.innerHeight - height - 12); }
				else if (rect.left - 12 >= box.width) { left = rect.left - box.width; top = Math.max(12, window.innerHeight - height - 12); }
				else { maxHeight = Math.max(above, below); top = above > below ? 12 : rect.bottom; }
			}
			setPosition((old) => old.left === left && old.top === top && old.maxHeight === maxHeight ? old : { left, top, maxHeight });
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
	}, [open, prefer, ...deps]);
	const inside = (node: EventTarget | null) => node instanceof Node && Boolean(anchor.current?.contains(node) || card.current?.contains(node));
	const leave = (next: EventTarget | null) => { if (!inside(next) && !inside(document.activeElement)) setOpen(false); };
	const anchorProps = {
		ref: anchor,
		onMouseEnter: () => setOpen(true),
		onMouseLeave: (event: { relatedTarget: EventTarget | null }) => leave(event.relatedTarget),
		onFocus: () => setOpen(true),
		onBlur: (event: { relatedTarget: EventTarget | null }) => { if (!inside(event.relatedTarget)) setOpen(false); },
		onKeyDown: (event: { key: string; stopPropagation(): void }) => { if (event.key === "Escape") { setOpen(false); event.stopPropagation(); } },
	};
	const render = (label: string, content: ReactNode) => open && createPortal(
		<section className="session-metadata" ref={card} style={{ position: "fixed", left: position.left, top: position.top, maxHeight: position.maxHeight }} id={id} aria-label={label} onMouseLeave={(event) => leave(event.relatedTarget)}>{content}</section>,
		document.body,
	);
	return { id, open, setOpen, anchorProps, render };
}
