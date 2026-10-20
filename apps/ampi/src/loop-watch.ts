// Always-on event-loop attribution for the hub log. The owner reports a freeze after the fact, when no AMPI_TRACE
// tracer runs, so the hub itself names each long block. A block is a 50 ms timer tick that comes more than 250 ms
// late. Its log line names the watched synchronous sections (agent frames, publishes, topics, browser frames) that
// ran in it. A per-minute line summarises the delay when its maximum passes 100 ms; /api/health returns the last
// whole minute. Cost with nothing slow: one 50 ms timer, a 10 ms delay histogram, and two clock reads per section.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

/** The last whole minute of event-loop delay, as /api/health reports it. */
export type LoopWindow = { endedAt: string; seconds: number; maxMs: number; p99Ms: number; over50: number; over250: number };

const TICK_MS = 50, BLOCK_MS = 250, SECTION_MS = 20, WINDOW_MS = 60_000, LINES_PER_WINDOW = 10, SUMMARY_MS = 100;
/**
 * The block attribution, apart from its timers. `tick()` runs every TICK_MS; `now` is the clock it and `watched`
 * read, so a test drives both with a fake clock.
 */
export class LoopWatch {
	#sections: { label: string; ms: number }[] = [];
	#short = { count: 0, ms: 0 };
	#tick: number;
	over50 = 0;
	over250 = 0;
	#lines = 0;
	suppressed = 0;

	readonly now: () => number;
	readonly log: (line: string) => void;

	constructor(now: () => number, log: (line: string) => void) {
		this.now = now;
		this.log = log;
		this.#tick = now();
	}

	/** Runs a synchronous section; one that takes 20 ms or more is named in the block line it falls in. */
	watched<T>(label: () => string, run: () => T): T {
		const t0 = this.now();
		try {
			return run();
		} finally {
			const ms = this.now() - t0;
			if (ms >= SECTION_MS) this.#sections.push({ label: label(), ms });
			else { this.#short.count++; this.#short.ms += ms; }
		}
	}

	tick(): void {
		const now = this.now(), late = now - this.#tick - TICK_MS;
		this.#tick = now;
		const ran = this.#sections, few = this.#short;
		this.#sections = [];
		this.#short = { count: 0, ms: 0 };
		if (late > 50) this.over50++;
		if (late <= BLOCK_MS) return;
		this.over250++;
		if (this.#lines >= LINES_PER_WINDOW) { this.suppressed++; return; }
		this.#lines++;
		const named = ran.sort((a, b) => b.ms - a.ms).slice(0, 3).map((s) => `${s.label} ${round(s.ms)} ms`);
		if (few.count) named.push(`+${few.count} short sections, ${round(few.ms)} ms`);
		this.log(`event loop: blocked ${round(late)} ms; ran: ${ran.length ? named.join(", ") : `no single section over ${SECTION_MS} ms${few.count ? `; ${named.at(-1)!.slice(1)}` : ""}`}`);
	}

	/** Ends a window: its counts restart. */
	endWindow(): void {
		this.over50 = this.over250 = this.#lines = this.suppressed = 0;
	}
}

const round = (ms: number) => Math.round(ms);
let watch: LoopWatch | undefined;
let last: LoopWindow | undefined;

/** Runs a synchronous section under the process watch (LoopWatch.watched); without a watch it only runs it. */
export function watched<T>(label: () => string, run: () => T): T {
	return watch ? watch.watched(label, run) : run();
}

/** ISO 8601 time in this machine's zone (TZ), with its offset, so log times match the owner's clock. */
export function localTime(at = new Date()): string {
	const offset = -at.getTimezoneOffset(), pad = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}${offset < 0 ? "-" : "+"}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** The last whole minute, or undefined during the first minute after start. */
export function loopWindow(): LoopWindow | undefined {
	return last;
}

/** Starts the watch for this process. `log` receives each block and summary line. */
export function startLoopWatch(log: (line: string) => void = (line) => console.error(line)): void {
	if (watch) return;
	const w = (watch = new LoopWatch(() => performance.now(), log));
	const delay = monitorEventLoopDelay({ resolution: 10 });
	delay.enable();
	let windowStart = Date.now();
	setInterval(() => w.tick(), TICK_MS).unref();
	setInterval(() => {
		const ms = (ns: number) => round(ns / 1e6);
		last = { endedAt: localTime(), seconds: round((Date.now() - windowStart) / 1000), maxMs: ms(delay.max), p99Ms: ms(delay.percentile(99)), over50: w.over50, over250: w.over250 };
		if (last.maxMs > SUMMARY_MS)
			log(`event loop: max ${last.maxMs} ms, p99 ${last.p99Ms} ms, ${w.over50} ticks over 50 ms, ${w.over250} over 250 ms (last ${last.seconds} s)${w.suppressed ? `; ${w.suppressed} block lines not logged` : ""}`);
		delay.reset();
		windowStart = Date.now();
		w.endWindow();
	}, WINDOW_MS).unref();
}
