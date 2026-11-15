import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { scaleOf } from "../display.ts";
import { registerOverlay } from "../keymap.ts";
import type { Overlay } from "../focus.ts";

/** The opener of the open Modal. A Modal opened from inside another (palette switching) inherits it. */
let modalOpener: HTMLElement | null = null;

export function Modal({ children, onClose, label = "AmPi dialog", overlay = "dialog" }: { children: React.ReactNode; onClose: () => void; label?: string; overlay?: Overlay }) {
	const ref = useRef<HTMLDivElement>(null);
	const active = document.activeElement as HTMLElement | null;
	const opener = useRef(active?.closest('[aria-modal="true"]') ? modalOpener : active);
	const close = useRef(onClose);
	close.current = onClose;
	const titleId = useId();
	// Every Modal gates global chords while it is open (focus R12), including Modals that App does not own.
	useLayoutEffect(() => registerOverlay(overlay), [overlay]);
	useLayoutEffect(() => {
		const modal = ref.current!;
		modalOpener = opener.current;
		const title = modal.querySelector("h2");
		if (title) { title.id = titleId; modal.setAttribute("aria-labelledby", titleId); }
		const controls = () => [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((el) => el.getClientRects().length > 0);
		if (!modal.contains(document.activeElement)) (controls()[0] ?? modal).focus({ preventScroll: true });
		const key = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); }
			if (e.key !== "Tab") return;
			const items = controls();
			const target = e.shiftKey ? items.at(-1) : items[0];
			if (!modal.contains(document.activeElement) || document.activeElement === modal || document.activeElement === (e.shiftKey ? items[0] : items.at(-1)) || !items.length) {
				e.preventDefault(); (target ?? modal).focus();
			}
		};
		document.addEventListener("keydown", key, true);
		let alertText: string | null = null;
		const revealError = () => {
			const alert = modal.querySelector<HTMLElement>('[role="alert"]');
			const text = alert?.textContent ?? null;
			if (text && text !== alertText) reveal(modal, alert!);
			alertText = text;
		};
		const observer = new MutationObserver(revealError);
		observer.observe(modal, { childList: true, characterData: true, subtree: true });
		const resize = new ResizeObserver(() => { alertText = null; revealError(); });
		resize.observe(modal);
		revealError();
		return () => {
			document.removeEventListener("keydown", key, true);
			observer.disconnect();
			resize.disconnect();
			if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
		};
	}, [titleId]);
	// Like a Popover, it renders in a body portal, outside every region's display zoom and every scroller.
	return createPortal(
		<div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div ref={ref} className="modal quiet-scroll" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
				{children}
			</div>
		</div>,
		document.body,
	);
}

/** Scrolls `item` into the view of `modal` only; `scrollIntoView` would also scroll the page's clipped ancestors. */
function reveal(modal: HTMLElement, item: HTMLElement) {
	const box = modal.getBoundingClientRect(), r = item.getBoundingClientRect();
	const by = r.top < box.top ? r.top - box.top : r.bottom > box.bottom ? Math.min(r.bottom - box.bottom, r.top - box.top) : 0;
	if (by) modal.scrollTop += by / scaleOf(modal);
}
