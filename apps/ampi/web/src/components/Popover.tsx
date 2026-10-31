import { useCallback, useEffect, useLayoutEffect, useRef, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { scaleOf } from "../display.ts";

/** A box in viewport px, as `getBoundingClientRect` returns it. A pointer is a box of zero size (`at`). */
export type Box = { left: number; top: number; right: number; bottom: number };
export const at = (x: number, y: number): Box => ({ left: x, top: y, right: x, bottom: y });

// Where the pointer last moved, in viewport px. The first hover handler installs the window listener, so importing a
// component has no side effect. The listener runs after React's handlers, so a handler still sees the position before
// its own event, and it records that event too: a listener added during dispatch on a later target still runs.
let pointer: string | undefined;
const track = (e: PointerEvent) => { pointer = `${e.clientX},${e.clientY}`; };
const intended = new WeakSet<Element>();

/**
 * Hover intent: the first pointer move inside an element after the pointer enters it. Content that slides or scrolls
 * under a still pointer fires enter and over events, and in WebKit a pointermove at the same position; none of them
 * is intent. Every hover trigger (a card, the prompt rail, a list item that takes the selection) uses this, never an
 * enter or over event. A touch has no hover.
 */
export function hoverIntent(enter: () => void) {
	return {
		onPointerMove: (e: ReactPointerEvent) => {
			if (pointer === undefined) { pointer = ""; window.addEventListener("pointermove", track); }
			if (e.pointerType === "touch" || intended.has(e.currentTarget) || `${e.clientX},${e.clientY}` === pointer) return;
			intended.add(e.currentTarget);
			enter();
		},
		onPointerLeave: (e: ReactPointerEvent) => { intended.delete(e.currentTarget); },
	};
}

/** The controls of an action menu that take focus, in order. */
const ITEMS = 'button:not(:disabled), a[href], [role=menuitem]:not([aria-disabled="true"])';

/** The CSS width that placePopover measures the scale on: an exact binary fraction, so zoom 1 measures exactly 1. */
const SCALE_PROBE = 4096;

/** The space between a popover and the viewport's edge, in viewport px. */
const EDGE = 12;

export type PopoverProps = {
	/** Where the popover opens, read at each placement: an element's rect or a pointer, in viewport px only. */
	anchor: () => Box | undefined;
	/** The side of the anchor the popover opens on. `left` aligns the tops; `below` and `above` align `align` edges. */
	side?: "below" | "above" | "left";
	align?: "start" | "end";
	/** The space between the anchor and the popover, in the popover's CSS px. */
	gap?: number;
	/** The area the popover stays inside, in viewport px: the viewport when absent, and never more than it. */
	bounds?: () => Box | undefined;
	/** The popover takes the anchor's width. */
	fit?: boolean;
	/** The element the popover belongs to: a press on it is not outside, and a scroll that moves it closes the popover. */
	owner?: Element | null;
	/**
	 * Turns on the close policy: Escape while focus is in the popover or its owner, a press outside both, a window blur,
	 * or a scroll that moves the owner. Escape inside the popover returns focus to the opener: the element in the owner
	 * that had focus when the popover opened, else the owner.
	 */
	onClose?: () => void;
	/**
	 * An action menu takes the keyboard: it focuses its first item on open, Tab, Shift+Tab and the arrow keys move
	 * only among its items, and a close while focus is inside returns focus to the opener. Without it the popover leaves
	 * focus where it is: a hover card, an outline, a combobox's list.
	 */
	menu?: boolean;
	ref?: Ref<HTMLDivElement>;
	children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "style" | "children">;

/**
 * The one way to show a menu, popover, card or outline above the page. It renders in a body portal with fixed
 * position, outside every region's display zoom and every scroller, so opening it can change no layout and no
 * ancestor's scroll. Its portal follows the page's other controls, so only `menu` brings the keyboard to it. It is
 * hidden until placed, so its first painted frame is in place; it opens on `side` of its anchor, flips to the other
 * side when that has more room, shrinks to the room and scrolls inside, and never leaves the viewport. It places again
 * when it renders, when the window, the display size, a scroller, a font, its own size or its owner's size changes.
 * Focus moves without scrolling. Placement reads viewport px and converts once, at the
 * popover, by its measured scale (display.ts); callers never compute `left` or `top`.
 */
export function Popover({ anchor, side = "below", align = "start", gap = 0, bounds, fit, owner, onClose, menu, ref, className, children, ...rest }: PopoverProps) {
	const node = useRef<HTMLDivElement | null>(null);
	const props = useRef({ anchor, side, align, gap, bounds, fit, owner, onClose, menu });
	props.current = { anchor, side, align, gap, bounds, fit, owner, onClose, menu };
	const setRef = useCallback((el: HTMLDivElement | null) => {
		node.current = el;
		if (typeof ref === "function") ref(el);
		else if (ref) ref.current = el;
	}, [ref]);
	const place = useCallback(() => {
		const el = node.current, p = props.current, box = p.anchor();
		if (!el || !box) return;
		placePopover(el, box, p);
		el.style.visibility = "";
	}, []);
	// Each render may move the anchor or change the content.
	useLayoutEffect(place);
	const opener = useRef<Element | null>(null);
	const back = useCallback(() => {
		const owner = props.current.owner, to = opener.current && owner?.contains(opener.current) ? opener.current : owner;
		if (to instanceof HTMLElement && to.isConnected) to.focus({ preventScroll: true });
	}, []);
	// A layout effect's cleanup runs while the popover is still in the document, so it can see focus inside.
	useLayoutEffect(() => {
		const el = node.current;
		opener.current = document.activeElement;
		if (!menu || !el) return;
		el.querySelector<HTMLElement>(ITEMS)?.focus({ preventScroll: true });
		return () => { if (el.contains(document.activeElement)) back(); };
	}, [menu, back]);
	useEffect(() => {
		const el = node.current!;
		const inside = (target: EventTarget | null) => target instanceof Node && (el.contains(target) || Boolean(props.current.owner?.contains(target)));
		const close = () => props.current.onClose?.();
		// A scroll event can arrive a frame after its scroll: only a changed owner box is a move. Only a scroller that holds
		// the owner moves it; the owner may also move for another reason, such as a header that settles after load.
		const spot = (owner?: Element | null) => { const r = owner?.getBoundingClientRect(); return r ? `${r.left},${r.top}` : ""; };
		const opened = spot(props.current.owner);
		const scrolled = (e: Event) => {
			if (e.target instanceof Node && el.contains(e.target)) return;
			const owner = props.current.owner;
			if (props.current.onClose && owner && e.target instanceof Node && e.target.contains(owner) && spot(owner) !== opened) close();
			else place();
		};
		const pressed = (e: PointerEvent) => !inside(e.target) && close();
		const key = (e: KeyboardEvent) => {
			if (props.current.menu && el.contains(document.activeElement) && step(e)) return;
			if (e.key !== "Escape" || !props.current.onClose || !inside(document.activeElement)) return;
			e.preventDefault(); e.stopPropagation();
			if (el.contains(document.activeElement)) back();
			close();
		};
		const step = (e: KeyboardEvent) => {
			const by = { Tab: e.shiftKey ? -1 : 1, ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[e.key];
			if (by === undefined || e.altKey || e.ctrlKey || e.metaKey) return false;
			const items = [...el.querySelectorAll<HTMLElement>(ITEMS)];
			if (items.length === 0) return false;
			e.preventDefault(); e.stopPropagation();
			const from = items.indexOf(document.activeElement as HTMLElement), last = items.length - 1;
			const next = by === -Infinity || (from < 0 && by > 0) ? 0 : by === Infinity || from < 0 ? last : (from + by + items.length) % items.length;
			items[next]!.focus({ preventScroll: true });
			return true;
		};
		// The observer reports each box once when it starts; the layout effect has placed the popover at that size, and a
		// second placement inside that report resizes an observed box again.
		const reported = new WeakSet<Element>();
		const sized = new ResizeObserver((entries) => {
			const changed = entries.some((entry) => reported.has(entry.target));
			for (const entry of entries) reported.add(entry.target);
			if (changed) place();
		});
		sized.observe(el);
		if (props.current.owner) sized.observe(props.current.owner);
		for (const name of ["resize", "ampi:display"]) window.addEventListener(name, place);
		window.addEventListener("scroll", scrolled, true);
		window.addEventListener("blur", close);
		document.addEventListener("pointerdown", pressed, true);
		document.addEventListener("keydown", key, true);
		document.fonts?.addEventListener("loadingdone", place);
		return () => {
			sized.disconnect();
			for (const name of ["resize", "ampi:display"]) window.removeEventListener(name, place);
			window.removeEventListener("scroll", scrolled, true);
			window.removeEventListener("blur", close);
			document.removeEventListener("pointerdown", pressed, true);
			document.removeEventListener("keydown", key, true);
			document.fonts?.removeEventListener("loadingdone", place);
		};
	}, [place, back]);
	return createPortal(
		<div ref={setRef} className={className ? `popover ${className}` : "popover"} style={{ left: 0, top: 0, visibility: "hidden" }} {...rest}>{children}</div>,
		document.body,
	);
}

/** Writes `el`'s fixed `left`, `top` and size limits from `anchor`; every length in is viewport px. */
function placePopover(el: HTMLElement, anchor: Box, { side, align, gap, bounds, fit }: { side: "below" | "above" | "left"; align: "start" | "end"; gap: number; bounds?: () => Box | undefined; fit?: boolean }) {
	// Measure at the origin: a fixed box without a set width shrinks to the room right of its current left. The scale is
	// measured on a fixed width, so it is a function of the zoom alone. Measured on the content's width, its rounding
	// noise changed with the content, the fonts and the last placement, and moved the popover by 1/64 px between runs.
	el.style.maxHeight = "";
	el.style.left = el.style.top = "0px";
	el.style.width = `${SCALE_PROBE}px`;
	el.style.maxWidth = "none";
	const scale = scaleOf(el), space = gap * scale;
	el.style.width = el.style.maxWidth = "";
	const area = bounds?.();
	const b = {
		left: Math.max(area?.left ?? 0, 0) + EDGE, top: Math.max(area?.top ?? 0, 0) + EDGE,
		right: Math.min(area?.right ?? Infinity, window.innerWidth) - EDGE, bottom: Math.min(area?.bottom ?? Infinity, window.innerHeight) - EDGE,
	};
	if (fit) el.style.width = `${(anchor.right - anchor.left) / scale}px`;
	const naturalWidth = el.getBoundingClientRect().width;
	let width = Math.min(naturalWidth, Math.max(0, b.right - b.left));
	// The side with room, else the side with more room; the popover narrows (left) or shrinks (below, above) to it and
	// never covers its anchor.
	const before = anchor.left - space - b.left, after = b.right - anchor.right - space;
	const leftward = before >= width || before >= after;
	if (side === "left") width = Math.max(0, Math.min(width, leftward ? before : after));
	// Text wraps at the final width, so the height is measured there.
	if (width < naturalWidth) el.style.maxWidth = `${width / scale}px`;
	const naturalHeight = el.getBoundingClientRect().height;
	let height = Math.min(naturalHeight, Math.max(0, b.bottom - b.top));
	// The edge margin yields to the anchor: a popover may reach an anchor that lies inside the margin.
	let left: number, top: number, low = b.bottom, high = b.top;
	if (side === "left") {
		left = leftward ? anchor.left - space - width : anchor.right + space;
		top = anchor.top;
	} else {
		const below = b.bottom - anchor.bottom - space, above = anchor.top - space - b.top;
		const preferred = side === "below" ? below : above, other = side === "below" ? above : below;
		const down = (preferred >= height || preferred >= other) === (side === "below");
		height = Math.max(0, Math.min(height, down ? below : above));
		top = down ? anchor.bottom + space : anchor.top - space - height;
		if (down) high = Math.min(high, top); else low = Math.max(low, Math.min(anchor.top - space, window.innerHeight));
		const start = align === "start" ? anchor.left : anchor.right - width;
		const flipped = align === "start" ? anchor.right - width : anchor.left;
		left = (align === "start" ? start + width > b.right : start < b.left) && flipped >= b.left && flipped + width <= b.right ? flipped : start;
	}
	left = Math.max(b.left, Math.min(left, b.right - width));
	top = Math.max(high, Math.min(top, low - height));
	if (height < naturalHeight) el.style.maxHeight = `${height / scale}px`;
	el.style.left = `${left / scale}px`;
	el.style.top = `${top / scale}px`;
}
