/** A scroll region's bar shows for this long after it scrolls, so a wheel or key scroll shows where the reader is. */
export const QUIET_SCROLL_REVEAL_MS = 1000;

/**
 * Marks a scrolled .quiet-scroll region with data-scrolled for QUIET_SCROLL_REVEAL_MS; styles.css then paints its thumb.
 * Scroll events do not bubble, so one capturing listener sees every region.
 */
export function installQuietScroll(root: Document = document) {
	const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
	root.addEventListener("scroll", (event) => {
		const el = event.target;
		if (!(el instanceof Element) || !el.classList.contains("quiet-scroll")) return;
		clearTimeout(timers.get(el));
		if (!el.hasAttribute("data-scrolled")) el.setAttribute("data-scrolled", "");
		timers.set(el, setTimeout(() => el.removeAttribute("data-scrolled"), QUIET_SCROLL_REVEAL_MS));
	}, { capture: true, passive: true });
}
