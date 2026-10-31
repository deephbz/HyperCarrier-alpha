/**
 * The axis of the current one-finger touch drag: one decision for every touch consumer. The drawer swipe
 * (drawer-swipe.ts) takes an x drag; the reader's scroll inputs (keep-place.ts, ThreadView's readerMoved) act only on
 * a y drag. The axis locks after LOCK_PX of travel and holds until the finger lifts. While it is pending, the first
 * pixels of a vertical drag count as no reader input yet. It has no import-time effect: installTouchAxis() binds it.
 */
export type Axis = "pending" | "x" | "y";

export const LOCK_PX = 10;

/** x when the travel is mostly sideways (|dx| > 1.5·|dy|), y otherwise; pending below LOCK_PX. */
export function lockAxis(dx: number, dy: number): Axis {
	if (Math.hypot(dx, dy) < LOCK_PX) return "pending";
	return Math.abs(dx) > 1.5 * Math.abs(dy) ? "x" : "y";
}

type Drag = { x: number; y: number; axis: Axis };
let drag: Drag | undefined;
const locked = new Set<(event: TouchEvent, axis: Axis) => void>();

/** The current drag's axis; "y" with no drag, so a scroll input with no touch reads as today. */
export function touchAxis(): Axis {
	return drag?.axis ?? "y";
}

/** The drag's start point, while a finger is down. */
export function touchStart(): { x: number; y: number } | undefined {
	return drag && { x: drag.x, y: drag.y };
}

/** Calls `listener` once per drag, on the touchmove that locks its axis. */
export function onAxisLock(listener: (event: TouchEvent, axis: Axis) => void): () => void {
	locked.add(listener);
	return () => locked.delete(listener);
}

const start = (event: TouchEvent) => {
	const touch = event.touches[0];
	// A second finger (a pinch) is no sideways drag.
	drag = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, axis: "pending" } : drag && { ...drag, axis: drag.axis === "x" ? "x" : "y" };
};
const move = (event: TouchEvent) => {
	const touch = event.touches[0];
	if (!drag || drag.axis !== "pending" || !touch) return;
	drag.axis = lockAxis(touch.clientX - drag.x, touch.clientY - drag.y);
	if (drag.axis !== "pending") for (const listener of locked) listener(event, drag.axis);
};
const end = (event: TouchEvent) => { if (event.touches.length === 0) drag = undefined; };
// Capture on window: the axis is known before any element's touch listener runs.
const OPTIONS = { capture: true, passive: true } as const;
let installs = 0;

/**
 * Starts the axis decision on `window`. The app calls it once at mount; a second call only counts. Returns the
 * uninstall; the last one removes the listeners. Without an install, touchAxis() reads "y" and no lock fires.
 */
export function installTouchAxis(): () => void {
	if (installs++ === 0) {
		window.addEventListener("touchstart", start, OPTIONS);
		window.addEventListener("touchmove", move, OPTIONS);
		window.addEventListener("touchend", end, OPTIONS);
		window.addEventListener("touchcancel", end, OPTIONS);
	}
	let done = false;
	return () => {
		if (done) return;
		done = true;
		if (--installs > 0) return;
		drag = undefined;
		window.removeEventListener("touchstart", start, OPTIONS);
		window.removeEventListener("touchmove", move, OPTIONS);
		window.removeEventListener("touchend", end, OPTIONS);
		window.removeEventListener("touchcancel", end, OPTIONS);
	};
}
