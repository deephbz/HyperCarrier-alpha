export type TimeRange = [number, number];
export type BrushMode = "pan" | "start" | "end" | "select";
export const MIN_SPAN = 60_000;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Pointer times use the full overview domain, independent of the current viewport. */
export function brushRange(mode: BrushMode, initial: TimeRange, anchor: number, point: number, bounds: TimeRange): TimeRange {
	const [min, max] = bounds;
	const [from, to] = initial;
	if (mode === "start") return [Math.round(clamp(point, min, to - MIN_SPAN)), to];
	if (mode === "end") return [from, Math.round(clamp(point, from + MIN_SPAN, max))];
	const span = Math.min(max - min, Math.max(MIN_SPAN, mode === "pan" ? to - from : Math.abs(point - anchor)));
	const start = clamp(mode === "pan" ? from + point - anchor : point < anchor ? anchor - span : anchor, min, max - span);
	return [Math.round(start), Math.round(start + span)];
}
