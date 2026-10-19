// Opt-in performance trace in Chrome Trace Event Format (Perfetto, chrome://tracing). `AMPI_TRACE=<dir>` enables it
// for a process and its worker threads; each thread appends to `<dir>/trace-<pid>-<tid>.json`. Timestamps are Unix-epoch
// microseconds, so every process and the browser share one clock. With tracing off, each call site costs one boolean
// check. Args stay small: counts, sizes, ids and statement shapes, never tokens or Session text.
//
// Files are an unterminated JSON array ("[" then comma-separated events, one per line), which the trace viewers accept; the perf
// report merges them. Buffers flush every 250 ms and at exit; a terminated worker loses at most its last 250 ms.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";

const dir = process.env.AMPI_TRACE;
/** True when this process records a trace. Guard any argument building with it. */
export const tracing = Boolean(dir);
export type TraceCat = "startup" | "http" | "ws" | "sqlite" | "derive" | "ipc" | "render" | "gc";
type Args = Record<string, string | number | boolean | null | undefined>;

const pid = process.pid;
const tid = threadId;
const file = dir ? join(dir, `trace-${pid}-${tid}.json`) : "";
let buffer: string[] = [];
let written = false;
let nextId = 1;

/** Unix-epoch microseconds on the shared trace clock. */
export function nowUs(): number {
	return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

function push(event: Record<string, unknown>): void {
	buffer.push(JSON.stringify({ pid, tid, ...event }));
}

export function instant(name: string, args?: Args, cat: TraceCat = "startup"): void {
	if (tracing) push({ ph: "i", s: "t", name, cat, ts: nowUs(), ...(args ? { args } : {}) });
}

/** A finished synchronous span that the caller timed. Spans on one thread must nest. */
export function complete(name: string, cat: TraceCat, startUs: number, args?: Args): void {
	if (tracing) push({ ph: "X", name, cat, ts: startUs, dur: Math.max(0, nowUs() - startUs), ...(args ? { args } : {}) });
}

/** Times a synchronous call as one nested span. */
export function span<T>(name: string, cat: TraceCat, run: () => T, args?: Args): T {
	if (!tracing) return run();
	const start = nowUs();
	try { return run(); } finally { complete(name, cat, start, args); }
}

/** Times async work on its own track: awaits interleave, so async work cannot be a nested span. */
export async function spanAsync<T>(name: string, cat: TraceCat, run: () => Promise<T>, args?: Args): Promise<T> {
	if (!tracing) return run();
	const id = nextId++;
	push({ ph: "b", name, cat, id, ts: nowUs(), ...(args ? { args } : {}) });
	try { return await run(); } finally { push({ ph: "e", name, cat, id, ts: nowUs() }); }
}

export function counter(name: string, values: Record<string, number>): void {
	if (tracing) push({ ph: "C", name, ts: nowUs(), args: values });
}

export function nameProcess(name: string): void {
	if (tracing) push({ ph: "M", name: "process_name", ts: 0, args: { name } });
}

export function nameThread(name: string): void {
	if (tracing) push({ ph: "M", name: "thread_name", ts: 0, args: { name } });
}

/** A statement's span name: its SQL shape (code, never bound values), whitespace-collapsed and bounded. */
export function sqlName(sql: string): string {
	const flat = sql.replace(/\s+/g, " ").trim();
	return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** With tracing on, every exec and every prepared statement's run/get/all/iterate becomes a `sqlite` span. */
export function traceDb(db: DatabaseSync, label: string): DatabaseSync {
	if (!tracing) return db;
	// Named wrappers: a CPU profile charges native SQLite time to the calling JS frame, so it shows as sqliteAll etc.
	const statement = (target: StatementSync, name: string) =>
		new Proxy(target, {
			get(stmt, key) {
				const value = Reflect.get(stmt, key, stmt);
				if (typeof value !== "function") return value;
				if (key === "run") return function sqliteRun(...params: never[]) {
					const start = nowUs();
					const result = stmt.run(...params);
					complete(name, "sqlite", start, { db: label, op: "run", changes: Number(result.changes) });
					return result;
				};
				if (key === "get") return function sqliteGet(...params: never[]) {
					const start = nowUs();
					const row = stmt.get(...params);
					complete(name, "sqlite", start, { db: label, op: "get", rows: row ? 1 : 0 });
					return row;
				};
				if (key === "all") return function sqliteAll(...params: never[]) {
					const start = nowUs();
					const rows = stmt.all(...params);
					complete(name, "sqlite", start, { db: label, op: "all", rows: rows.length });
					return rows;
				};
				if (key === "iterate") return function* sqliteIterate(...params: never[]) {
					// Consumers interleave work between rows, so only the SQLite steps count as this statement's time.
					const iterator = stmt.iterate(...params);
					const first = nowUs();
					let rows = 0, busy = 0;
					try {
						for (;;) {
							const start = nowUs();
							const next = iterator.next();
							busy += nowUs() - start;
							if (next.done) break;
							rows++;
							yield next.value;
						}
					} finally {
						push({ ph: "i", s: "t", name, cat: "sqlite", ts: first, args: { db: label, op: "iterate", rows, busyUs: busy } });
					}
				};
				return value.bind(stmt);
			},
		});
	return new Proxy(db, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			if (key === "prepare") return (sql: string) => statement(span("prepare", "sqlite", () => target.prepare(sql), { db: label }), sqlName(sql));
			if (key === "exec") return function sqliteExec(sql: string) { return span(sqlName(sql), "sqlite", () => target.exec(sql), { db: label, op: "exec" }); };
			return value.bind(target);
		},
	});
}

/** Appends buffered events to this thread's file. Synchronous, so exit handlers can call it. */
export function flushTrace(): void {
	if (!tracing || !buffer.length) return;
	const events = buffer;
	buffer = [];
	// Each flush ends with a newline, so a reader that tails the file sees only whole events.
	const text = `${written ? "," : "[\n"}${events.join(",\n")}\n`;
	try {
		if (!written) mkdirSync(dir!, { recursive: true });
		appendFileSync(file, text);
		written = true;
	} catch {}
}

if (tracing) {
	nameThread(isMainThread ? "main" : `worker-${tid}`);
	push({ ph: "i", s: "t", name: "thread-start", cat: "startup", ts: Math.round(performance.timeOrigin * 1000) });
	// --cpu-prof samples use V8's own clock. The report finds this named 3 ms spin in the samples and aligns them.
	const ampiTraceClockSync = () => {
		const start = nowUs();
		while (nowUs() - start < 3000);
		push({ ph: "X", name: "clock-sync", cat: "startup", ts: start, dur: nowUs() - start });
	};
	ampiTraceClockSync();
	// Event-loop delay, memory and GC per thread; RSS is process-wide, so only the main thread reports it.
	const delay = monitorEventLoopDelay({ resolution: 10 });
	delay.enable();
	const sample = () => {
		const ms = (ns: number) => Math.round(ns / 1e4) / 100;
		if (delay.count) counter("event-loop-delay-ms", { p50: ms(delay.percentile(50)), p99: ms(delay.percentile(99)), max: ms(delay.max) });
		delay.reset();
		const mb = (n: number) => Math.round(n / 1e4) / 100;
		const memory = process.memoryUsage();
		counter("memory-mb", { ...(isMainThread ? { rss: mb(memory.rss) } : {}), heapUsed: mb(memory.heapUsed), heapTotal: mb(memory.heapTotal), external: mb(memory.external) });
		flushTrace();
	};
	setInterval(sample, 250).unref();
	const gc = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			const kind = (entry as { detail?: { kind?: number } }).detail?.kind;
			push({ ph: "X", name: "gc", cat: "gc", ts: Math.round((performance.timeOrigin + entry.startTime) * 1000), dur: Math.round(entry.duration * 1000), args: { kind: kind ?? null } });
		}
	});
	gc.observe({ entryTypes: ["gc"] });
	process.on("exit", () => {
		sample();
		flushTrace();
	});
}
