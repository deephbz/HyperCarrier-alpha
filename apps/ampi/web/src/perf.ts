// Page marks for the perf runner (scripts/perf/browser.mjs). The driver sets `__AMPI_PERF__` before any page script
// runs; without it every mark is one boolean check and nothing else.

declare global {
	interface Window {
		__AMPI_PERF__?: boolean;
	}
}

const on = typeof window !== "undefined" && window.__AMPI_PERF__ === true;
const once = new Set<string>();

/** A `performance.mark` named `ampi:<name>`. The driver reads them on the page clock and shifts them to epoch µs. */
export function perfMark(name: string): void {
	if (on) performance.mark(`ampi:${name}`);
}

/** The first `ampi:<name>` mark only: milestones such as first-data happen once per page load. */
export function perfMarkOnce(name: string): void {
	if (!on || once.has(name)) return;
	once.add(name);
	performance.mark(`ampi:${name}`);
}

/** Marks after the next frame is painted, so the mark measures what the owner sees. */
export function perfMarkPainted(name: string, first = false): void {
	if (!on || (first && once.has(name))) return;
	if (first) once.add(name);
	requestAnimationFrame(() => setTimeout(() => performance.mark(`ampi:${name}`), 0));
}
