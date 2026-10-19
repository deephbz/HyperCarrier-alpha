export type TimelineWindow = 96 | 48 | 24 | 12 | "Custom" | "Session life";
const HOUR = 3600_000;

export function timelineWindow(from?: number, to?: number, sessionLife = false): TimelineWindow {
	if (from === undefined || to === undefined) return sessionLife ? "Session life" : 96;
	return ([96, 48, 24, 12] as const).find((hours) => Math.abs(to - from - hours * HOUR) < 1) ?? "Custom";
}

export function nextTimelineWindow(current: TimelineWindow, panel = false): Exclude<TimelineWindow, "Custom"> {
	if (current === "Custom" || current === "Session life") return 96;
	return current === 96 ? 48 : current === 48 ? 24 : current === 24 ? 12 : panel ? "Session life" : 96;
}

export function windowRange(hours: number, now: number): [number, number] {
	return [now - Math.min(96, hours) * HOUR, now];
}
