import { useId, useRef, useState, type ReactNode } from "react";
import { Popover, hoverIntent } from "./Popover.tsx";

/**
 * A card that hover intent (Popover.tsx) or keyboard focus opens beside its anchor: a Popover below it, or above it with `prefer`. It
 * stays open while the pointer or focus is inside the anchor or the card. The Popover's close policy also holds:
 * Escape while focus is in the anchor, a press elsewhere. React events from the card bubble to the anchor.
 */
export function useHoverCard<T extends HTMLElement>({ prefer = "below" }: { prefer?: "below" | "above" } = {}) {
	const id = useId();
	const anchor = useRef<T>(null);
	const card = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const inside = (node: EventTarget | null) => node instanceof Node && Boolean(anchor.current?.contains(node) || card.current?.contains(node));
	const leave = (next: EventTarget | null) => { if (!inside(next) && !inside(document.activeElement)) setOpen(false); };
	const anchorProps = {
		ref: anchor,
		...hoverIntent(() => setOpen(true)),
		onMouseLeave: (event: { relatedTarget: EventTarget | null }) => leave(event.relatedTarget),
		onFocus: () => setOpen(true),
		onBlur: (event: { relatedTarget: EventTarget | null }) => { if (!inside(event.relatedTarget)) setOpen(false); },
	};
	const render = (label: string, content: ReactNode) => open && (
		<Popover className="session-metadata quiet-scroll" ref={card} id={id} role="region" aria-label={label} anchor={() => anchor.current?.getBoundingClientRect()} side={prefer} owner={anchor.current} onClose={() => setOpen(false)} onMouseLeave={(event) => leave(event.relatedTarget)}>
			{content}
		</Popover>
	);
	return { id, open, setOpen, anchorProps, render };
}
