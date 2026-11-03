import type { DemoDataMode } from "./modes.ts";

function boundedCount(name: string, value: string | undefined, fallback: number, maximum: number, minimum = 0): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
	return Math.max(minimum, Math.min(maximum, parsed));
}

/** Huge demo mode defaults to its broad stress fixture; explicit inputs can isolate Session and transcript volume. */
export function demoStressConfig(mode: DemoDataMode, sessions: string | undefined, entriesPerSession: string | undefined) {
	return {
		sessions: boundedCount("DEMO_STRESS", sessions, mode === "huge" ? 1000 : 0, 1000),
		entriesPerSession: boundedCount("DEMO_STRESS_ENTRIES_PER_SESSION", entriesPerSession, 96, 1000, 1),
	};
}
