// Perf report: merges a run directory's traces into one Perfetto timeline and answers "where did the time go".
//
// Inputs in <runDir>: trace-<pid>-<tid>.json (hub threads, remote agent), trace-browser.json (already on the shared
// clock), CPU.*.cpuprofile (--cpu-prof, one per thread), receipt.json (runner: external timings, marks, args).
// Outputs: trace.json (all processes and threads, plus CPU samples as stacks), summary.json, summary.md.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The owner-facing targets. README.md "Targets and limits" is their documentation; keep the two in step. */
export const LIMITS = [
	{ id: "health", label: "Health answers (spawn → /api/health 200)", unit: "ms", max: 500, scenarios: ["startup", "switch", "idle"] },
	{ id: "hub-start", label: "Hub listens (spawn → listen)", unit: "ms", max: 1000, scenarios: ["startup", "switch", "idle"] },
	{ id: "post-listen-block", label: "Main-loop block after listen (max event-loop delay)", unit: "ms", max: 50, scenarios: ["startup", "switch", "idle"] },
	{ id: "switch-first-p95", label: "First-visit Session switch p95", unit: "ms", max: 50, scenarios: ["switch"] },
	{ id: "switch-revisit-p95", label: "Revisit Session switch p95", unit: "ms", max: 50, scenarios: ["switch"] },
	// The owner's launch target: first UI paint within half a Dock bounce. Both readings of "first UI paint" are checked.
	{ id: "app-window", label: "AmPi.app open → window shown", unit: "ms", max: 500, scenarios: ["app"] },
	{ id: "app-first-row", label: "AmPi.app open → first painted Session row", unit: "ms", max: 500, scenarios: ["app"] },
	{ id: "idle-rss", label: "Idle RSS, hub + workers", unit: "MB", max: 400, scenarios: ["startup", "switch", "idle", "index", "app"] },
	{ id: "loop-wall", label: "Loop wall (prepare → stopped → report)", unit: "ms", max: 10_000, scenarios: ["startup", "switch", "idle", "app"] },
	{ id: "index-complete", label: "Cold index completes (queue drained)", unit: "bool", min: 1, scenarios: ["index"] },
	{ id: "index-rate-tail", label: "Cold index rate, last 10% ÷ first 10%", unit: "ratio", min: 0.5, scenarios: ["index"] },
];

// ---- parsing ----

/** Reads one trace file: a JSON array, `{traceEvents}`, or the unterminated array trace.ts appends to. */
export function parseTrace(text) {
	const body = text.trim();
	if (!body) return [];
	if (body.startsWith("{")) return JSON.parse(body).traceEvents ?? [];
	try {
		return JSON.parse(body);
	} catch {}
	// Unterminated: one event per line after "[". A torn last line (a killed process) is dropped.
	const events = [];
	for (const raw of body.replace(/^\[/, "").split("\n")) {
		const line = raw.trim().replace(/^,/, "").replace(/,$/, "").replace(/\]$/, "");
		if (!line) continue;
		try {
			events.push(JSON.parse(line));
		} catch {}
	}
	return events;
}

/** `CPU.<date>.<time>.<pid>.<tid>.<seq>.cpuprofile` → { pid, tid }. */
export function profileThread(name) {
	const m = /^CPU\.\d+\.\d+\.(\d+)\.(\d+)\.\d+\.cpuprofile$/.exec(name);
	return m ? { pid: Number(m[1]), tid: Number(m[2]) } : undefined;
}

/** Source location without machine paths: the repo-relative or package-relative tail only. */
export function shortUrl(url) {
	if (!url) return "";
	const clean = url.replace(/^file:\/\//, "");
	for (const anchor of ["/node_modules/", "/apps/ampi/", "/apps/", "/packages/"]) {
		const at = clean.lastIndexOf(anchor);
		if (at >= 0) return clean.slice(at + 1);
	}
	return clean.startsWith("node:") ? clean : basename(clean);
}

// ---- statistics ----

export function quantile(values, q) {
	if (!values.length) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const at = (sorted.length - 1) * q;
	const lo = Math.floor(at), hi = Math.ceil(at);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}
export const median = (values) => quantile(values, 0.5);
const round = (n, digits = 1) => (n === undefined || n === null || Number.isNaN(n) ? undefined : Math.round(n * 10 ** digits) / 10 ** digits);
const ms = (us) => round(us / 1000);

/**
 * Self and total time per X span name, plus top-level spans, per thread. Spans on one thread nest by construction
 * (trace.ts emits X only for synchronous work); a child's time is subtracted from its parent's self time.
 */
export function spanTable(events) {
	const byThread = new Map();
	for (const e of events) {
		if (e.ph !== "X" || e.cat === "gc" || e.cat === "cpu") continue;
		const key = `${e.pid}:${e.tid}`;
		if (!byThread.has(key)) byThread.set(key, []);
		byThread.get(key).push(e);
	}
	const stats = new Map();
	const topLevel = new Map();
	for (const [key, list] of byThread) {
		list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
		const stack = [];
		const tops = [];
		for (const e of list) {
			while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop();
			const parent = stack.at(-1);
			const entry = { e, child: 0 };
			if (parent && e.ts + e.dur <= parent.e.ts + parent.e.dur) parent.child += e.dur;
			else if (!parent) tops.push(e);
			stack.push(Object.assign(entry, { ts: e.ts, dur: e.dur }));
			const id = `${e.cat}\u0000${e.name}`;
			if (!stats.has(id)) stats.set(id, { name: e.name, cat: e.cat, count: 0, total: 0, self: 0, max: 0, rows: 0, entries: [] });
			const s = stats.get(id);
			s.count++;
			s.total += e.dur;
			s.max = Math.max(s.max, e.dur);
			s.rows += Number(e.args?.rows ?? e.args?.changes ?? 0);
			s.entries.push(entry);
		}
		topLevel.set(key, tops);
	}
	for (const s of stats.values()) {
		s.self = s.entries.reduce((sum, entry) => sum + entry.e.dur - entry.child, 0);
		delete s.entries;
	}
	return { stats: [...stats.values()], topLevel };
}

/** Async spans (b/e pairs) as intervals. */
export function asyncSpans(events) {
	const open = new Map();
	const out = [];
	for (const e of events) {
		const key = `${e.pid}:${e.cat}:${e.name}:${e.id}`;
		if (e.ph === "b") open.set(key, e);
		else if (e.ph === "e" && open.has(key)) {
			const b = open.get(key);
			open.delete(key);
			out.push({ name: e.name, cat: e.cat, pid: e.pid, tid: b.tid, ts: b.ts, dur: e.ts - b.ts, args: b.args });
		}
	}
	return out;
}

/** CPU profile samples with durations: sample i lasts until sample i+1; the last one gets the median interval. */
export function profileSamples(profile) {
	const parent = new Map();
	const byId = new Map();
	for (const node of profile.nodes) {
		byId.set(node.id, node);
		for (const child of node.children ?? []) parent.set(child, node.id);
	}
	const deltas = profile.timeDeltas ?? [];
	const ids = profile.samples ?? [];
	let t = profile.startTime;
	const times = ids.map((_, i) => (t += deltas[i] ?? 0));
	const typical = median(deltas.slice(1).filter((d) => d > 0)) ?? 1000;
	const samples = ids.map((id, i) => ({ id, ts: times[i], dur: i + 1 < ids.length ? Math.max(0, times[i + 1] - times[i]) : typical, node: byId.get(id) }));
	return { samples, byId, parent };
}

const IDLE = new Set(["(idle)"]);
const frameName = (node) => node.callFrame.functionName || "(anonymous)";

/** Busy and idle time per profile, and self time per function. */
export function profileStats(profile) {
	let busy = 0, idle = 0;
	const self = new Map();
	for (const s of profileSamples(profile).samples) {
		const node = s.node;
		if (!node) continue;
		if (IDLE.has(node.callFrame.functionName)) {
			idle += s.dur;
			continue;
		}
		busy += s.dur;
		const where = node.callFrame.url ? `${shortUrl(node.callFrame.url)}:${node.callFrame.lineNumber + 1}` : "";
		const key = `${frameName(node)}\u0000${where}`;
		self.set(key, (self.get(key) ?? 0) + s.dur);
	}
	return {
		busy,
		idle,
		wall: profile.endTime - profile.startTime,
		functions: [...self].map(([key, us]) => ({ fn: key.split("\u0000")[0], where: key.split("\u0000")[1], self: us })),
	};
}

/**
 * CPU samples as nested X events on a companion track, so Perfetto shows the call stacks beside the spans.
 * `shiftUs` maps the profile clock onto the trace clock. Runs of identical frames merge.
 */
export function profileToEvents(profile, { pid, tid, shiftUs, maxDepth = 32 }) {
	const { samples, byId, parent } = profileSamples(profile);
	const out = [];
	const open = [];
	// Whole microseconds and exact durations keep every frame inside its parent; Perfetto rejects partial overlaps.
	const at = (us) => Math.round(us + shiftUs);
	const close = (depth, end) => {
		while (open.length > depth) {
			const frame = open.pop();
			if (end > frame.ts) out.push({ ph: "X", pid, tid, cat: "cpu", name: frame.name, ts: frame.ts, dur: end - frame.ts, ...(frame.where ? { args: { where: frame.where } } : {}) });
		}
	};
	for (const s of samples) {
		if (!s.node || IDLE.has(s.node.callFrame.functionName)) {
			close(0, at(s.ts));
			continue;
		}
		const stack = [];
		for (let id = s.id; id !== undefined; id = parent.get(id)) {
			const node = byId.get(id);
			if (!node || node.callFrame.functionName === "(root)") break;
			stack.unshift(node);
		}
		const frames = stack.slice(0, maxDepth);
		let same = 0;
		while (same < open.length && same < frames.length && open[same].id === frames[same].id) same++;
		close(same, at(s.ts));
		for (let i = same; i < frames.length; i++) {
			const node = frames[i];
			open.push({ id: node.id, name: frameName(node), where: node.callFrame.url ? `${shortUrl(node.callFrame.url)}:${node.callFrame.lineNumber + 1}` : "", ts: at(s.ts) });
		}
	}
	const last = samples.at(-1);
	close(0, last ? at(last.ts + last.dur) : 0);
	return out;
}

// ---- run directory ----

/** Reads every trace and profile in a run directory. */
export function loadRun(runDir) {
	const files = readdirSync(runDir);
	const events = [];
	for (const name of files) {
		if (!/^trace-.+\.json$/.test(name)) continue;
		// A loop, not push(...): a browser trace can exceed the engine's argument limit.
		for (const event of parseTrace(readFileSync(join(runDir, name), "utf8"))) events.push(event);
	}
	const profiles = [];
	for (const name of files) {
		const thread = profileThread(name);
		if (thread) profiles.push({ name, ...thread, profile: JSON.parse(readFileSync(join(runDir, name), "utf8")) });
	}
	const receipt = existsSync(join(runDir, "receipt.json")) ? JSON.parse(readFileSync(join(runDir, "receipt.json"), "utf8")) : {};
	return { events, profiles, receipt };
}

/** Thread labels from M events: "hub/main", "hub/derive-worker", "remote-agent:x/main". */
export function threadNames(events) {
	const processes = new Map(), threads = new Map();
	for (const e of events) {
		if (e.ph !== "M") continue;
		if (e.name === "process_name") processes.set(e.pid, e.args?.name);
		if (e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args?.name);
	}
	return (pid, tid) => `${processes.get(pid) ?? `pid ${pid}`}/${threads.get(`${pid}:${tid}`) ?? `tid ${tid}`}`;
}

/**
 * Profile clock → trace clock. trace.ts spins 3 ms in `ampiTraceClockSync` and records that span; the samples inside
 * the function mark the same interval on the profile clock. The midpoints align to within one sample interval.
 */
export function profileShift(events, profile, pid, tid) {
	const sync = events.find((e) => e.ph === "X" && e.name === "clock-sync" && e.pid === pid && e.tid === tid);
	if (!sync) return undefined;
	const { samples, byId, parent } = profileSamples(profile);
	const inside = samples.filter((s) => {
		for (let id = s.id; id !== undefined; id = parent.get(id)) if (byId.get(id)?.callFrame.functionName === "ampiTraceClockSync") return true;
		return false;
	});
	if (!inside.length) return undefined;
	const from = inside[0].ts, to = inside.at(-1).ts + inside.at(-1).dur;
	return sync.ts + sync.dur / 2 - (from + to) / 2;
}

const MILESTONES = ["thread-start", "modules-loaded", "listen", "health-ok", "host-loaded", "agent-hello", "first-ws-connect", "first-ws-frame", "first-snapshot", "stop-requested", "stopped"];

/** The analysis behind summary.md and summary.json. Pure: unit tests feed it synthetic events. */
export function analyze({ events, profiles = [], receipt = {} }) {
	const label = threadNames(events);
	const hubPid = events.find((e) => e.ph === "M" && e.name === "process_name" && e.args?.name === "hub")?.pid ?? receipt.hubPid;
	const ext = receipt.external ?? {};
	const hubStart = events.find((e) => e.name === "thread-start" && e.pid === hubPid && e.tid === 0)?.ts;
	const t0 = ext.spawnUs ?? hubStart ?? events.reduce((min, e) => (e.ts > 0 && e.ts < min ? e.ts : min), Infinity);
	const rel = (ts) => (ts === undefined ? undefined : ms(ts - t0));

	// Milestones: first instant of each name in the hub, then the scenario's page marks.
	const milestones = {};
	for (const name of MILESTONES) {
		const e = events.find((x) => (x.ph === "i" || x.ph === "I") && x.name === name && x.pid === hubPid && (name !== "thread-start" || x.tid === 0));
		if (e) milestones[name === "thread-start" ? "process-start" : name] = rel(e.ts);
	}
	const marks = receipt.scenario?.marks ?? [];
	for (const m of marks) if (!m.name.startsWith("switch-done") && milestones[m.name] === undefined) milestones[m.name] = rel(m.ts);
	if (milestones["first-data"] === undefined && ext.probeFirstDataUs) milestones["first-data"] = rel(ext.probeFirstDataUs);
	if (ext.healthUs) milestones["health-external"] = rel(ext.healthUs);

	// Phases between consecutive milestones on the hub main thread: the critical path with its top spans.
	const { stats, topLevel } = spanTable(events);
	const mainTops = topLevel.get(`${hubPid}:0`) ?? [];
	const phaseNames = ["process-start", "modules-loaded", "listen", "health-ok", "first-snapshot", "first-data"].filter((n) => milestones[n] !== undefined);
	const points = [{ name: "spawn", at: 0 }, ...phaseNames.map((name) => ({ name, at: milestones[name] }))].sort((a, b) => a.at - b.at);
	const phases = [];
	for (let i = 1; i < points.length; i++) {
		const from = t0 + points[i - 1].at * 1000, to = t0 + points[i].at * 1000;
		const inside = new Map();
		for (const e of mainTops) {
			const overlap = Math.min(to, e.ts + e.dur) - Math.max(from, e.ts);
			if (overlap > 0) inside.set(e.name, (inside.get(e.name) ?? 0) + overlap);
		}
		const traced = [...inside.values()].reduce((a, b) => a + b, 0);
		phases.push({
			from: points[i - 1].name, to: points[i].name, ms: round(points[i].at - points[i - 1].at),
			tracedMs: ms(traced),
			top: [...inside].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, us]) => ({ name, ms: ms(us) })),
		});
	}

	// Threads: traced busy time (top-level spans), CPU busy/idle (profiles), event-loop delay, GC, heap.
	const threads = new Map();
	const thread = (pid, tid) => {
		const key = `${pid}:${tid}`;
		if (!threads.has(key)) threads.set(key, { thread: label(pid, tid), pid, tid, tracedMs: 0, eld: [], gc: [], heap: [] });
		return threads.get(key);
	};
	for (const [key, tops] of topLevel) {
		const [pid, tid] = key.split(":").map(Number);
		thread(pid, tid).tracedMs = ms(tops.reduce((sum, e) => sum + e.dur, 0));
	}
	const rss = [];
	const listenTs = events.find((e) => e.name === "listen" && e.pid === hubPid)?.ts;
	let postListenBlock;
	for (const e of events) {
		if (e.ph === "C" && e.name === "event-loop-delay-ms") {
			thread(e.pid, e.tid).eld.push(e.args);
			// A sample covers the 250 ms before it; count only windows that start after listen.
			if (e.pid === hubPid && e.tid === 0 && listenTs !== undefined && e.ts - 250_000 >= listenTs) postListenBlock = Math.max(postListenBlock ?? 0, e.args.max);
		}
		if (e.ph === "C" && e.name === "memory-mb") {
			thread(e.pid, e.tid).heap.push(e.args.heapUsed);
			if (e.pid === hubPid && e.args.rss !== undefined) rss.push(e.args.rss);
		}
		if (e.ph === "X" && e.cat === "gc") thread(e.pid, e.tid).gc.push(e.dur);
	}
	const functions = [];
	for (const p of profiles) {
		const s = profileStats(p.profile);
		const t = thread(p.pid, p.tid);
		t.cpuBusyMs = ms(s.busy);
		t.cpuIdleMs = ms(s.idle);
		t.cpuWallMs = ms(s.wall);
		for (const f of s.functions) functions.push({ ...f, thread: t.thread });
	}
	const threadRows = [...threads.values()].map((t) => ({
		thread: t.thread, tracedMs: t.tracedMs, cpuBusyMs: t.cpuBusyMs, cpuIdleMs: t.cpuIdleMs, cpuWallMs: t.cpuWallMs,
		eldP50: round(median(t.eld.map((x) => x.p50))), eldP99: round(t.eld.reduce((m, x) => Math.max(m, x.p99), -Infinity)), eldMax: round(t.eld.reduce((m, x) => Math.max(m, x.max), -Infinity)),
		gcCount: t.gc.length, gcMs: ms(t.gc.reduce((a, b) => a + b, 0)), gcMaxMs: ms(Math.max(0, ...t.gc)), heapPeakMb: round(Math.max(0, ...t.heap)),
	})).map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v === -Infinity ? undefined : v])));

	// SQLite statements: X spans plus iterate instants (only SQLite step time counts).
	const sqlite = new Map();
	for (const s of stats) if (s.cat === "sqlite" && s.name !== "prepare" && s.name !== "sqlite-open") sqlite.set(s.name, { name: s.name, count: s.count, total: s.total, max: s.max, rows: s.rows });
	for (const e of events) {
		if (e.ph !== "i" || e.cat !== "sqlite") continue;
		const row = sqlite.get(e.name) ?? { name: e.name, count: 0, total: 0, max: 0, rows: 0 };
		row.count++;
		row.total += e.args?.busyUs ?? 0;
		row.max = Math.max(row.max, e.args?.busyUs ?? 0);
		row.rows += e.args?.rows ?? 0;
		sqlite.set(e.name, row);
	}

	// Switches from page marks.
	const switches = {};
	for (const kind of ["first", "revisit"]) {
		const durs = marks.filter((m) => m.name === `switch-done-${kind}` && m.dur !== undefined).map((m) => m.dur / 1000);
		if (durs.length) switches[kind] = { n: durs.length, p50: round(median(durs)), p95: round(quantile(durs, 0.95)), max: round(Math.max(...durs)) };
	}

	// Cold index: derive jobs completed over time.
	const derives = events.filter((e) => e.ph === "X" && e.cat === "derive" && e.name === "derive").map((e) => e.ts + e.dur).sort((a, b) => a - b);
	let index;
	if (derives.length >= 10 || receipt.scenario?.name === "index") index = indexRate(derives, ext.drainedUs);

	const memory = { peakRssMb: round(Math.max(ext.peakRssMb ?? 0, ...rss)), idleRssMb: round(ext.idleRssMb ?? rss.at(-1)) };
	const external = {
		healthMs: rel(ext.healthUs), listenMs: milestones.listen, shutdownMs: round(ext.stopMs), shutdownForced: ext.stopForced ?? false,
		loopWallMs: round(ext.loopWallMs), setupMs: ext.setupMs, lockWaitMs: ext.lockWaitMs, cloneMs: ext.cloneMs, reportMs: ext.reportMs, agentPids: ext.agentPids?.length,
	};
	const summary = {
		run: { commit: receipt.commit, dirty: receipt.dirty, node: receipt.node, fixture: receipt.fixture?.id, scenario: receipt.scenario?.name, driver: receipt.scenario?.driver, trace: receipt.args?.trace, loadBefore: receipt.load?.before, loadAfter: receipt.load?.after },
		host: hostLoad(receipt.load),
		scenario: { ok: receipt.scenario?.ok, error: receipt.scenario?.error, stats: receipt.scenario?.stats },
		milestones, phases, external, memory, switches, index,
		threads: threadRows.sort((a, b) => (b.cpuBusyMs ?? b.tracedMs ?? 0) - (a.cpuBusyMs ?? a.tracedMs ?? 0)),
		spans: stats.map((s) => ({ name: s.name, cat: s.cat, count: s.count, totalMs: ms(s.total), selfMs: ms(s.self), maxMs: ms(s.max) })).sort((a, b) => b.totalMs - a.totalMs).slice(0, 20),
		spansBySelf: stats.map((s) => ({ name: s.name, cat: s.cat, count: s.count, selfMs: ms(s.self) })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 10),
		asyncSpans: asyncSpans(events).sort((a, b) => b.dur - a.dur).slice(0, 10).map((s) => ({ name: s.name, ms: ms(s.dur), startMs: rel(s.ts) })),
		sqlite: [...sqlite.values()].sort((a, b) => b.total - a.total).slice(0, 10).map((s) => ({ name: s.name, count: s.count, totalMs: ms(s.total), maxMs: ms(s.max), rows: s.rows })),
		functions: functions.sort((a, b) => b.self - a.self).slice(0, 15).map((f) => ({ fn: f.fn, where: f.where, thread: f.thread, selfMs: ms(f.self) })),
		eld: { postListenMaxMs: postListenBlock },
	};
	summary.limits = checkLimits(summary);
	summary.metrics = metrics(summary);
	return summary;
}

/** Completed-jobs curve, plus the tail-rate ratio: last 10% of jobs per second ÷ first 10% per second. */
export function indexRate(ends, drainedUs) {
	if (!ends.length) return { jobs: 0, complete: drainedUs !== undefined };
	const n = Math.max(1, Math.floor(ends.length / 10));
	const span = (a, b) => Math.max(1, ends[b] - ends[a]) / 1e6;
	const first = n / span(0, Math.min(n, ends.length - 1));
	const last = n / span(Math.max(0, ends.length - 1 - n), ends.length - 1);
	const start = ends[0];
	const buckets = [];
	for (const end of ends) {
		const second = Math.floor((end - start) / 1e6);
		buckets[second] = (buckets[second] ?? 0) + 1;
	}
	return {
		jobs: ends.length, complete: drainedUs !== undefined, seconds: round((ends.at(-1) - start) / 1e6),
		firstRate: round(first), lastRate: round(last), tailRatio: round(last / first, 2), perSecond: Array.from(buckets, (b) => b ?? 0),
	};
}

export function checkLimits(summary) {
	const values = {
		health: summary.external.healthMs ?? summary.milestones["health-ok"],
		"hub-start": summary.milestones.listen,
		"post-listen-block": summary.eld.postListenMaxMs,
		"switch-first-p95": summary.switches.first?.p95,
		"switch-revisit-p95": summary.switches.revisit?.p95,
		"app-window": summary.scenario?.stats?.["open→window-shown"],
		"app-first-row": summary.scenario?.stats?.["open→first-session-row-painted"],
		"idle-rss": summary.memory.idleRssMb,
		"loop-wall": summary.external.loopWallMs,
		"index-complete": summary.index ? Number(summary.index.complete) : undefined,
		"index-rate-tail": summary.index?.tailRatio,
	};
	const scenario = summary.run.scenario;
	return LIMITS.filter((l) => !scenario || l.scenarios.includes(scenario)).map((l) => {
		const value = values[l.id];
		const pass = value === undefined ? null : l.max !== undefined ? value <= l.max : value >= l.min;
		return { id: l.id, label: l.label, target: l.max !== undefined ? `≤ ${l.max}` : `≥ ${l.min}`, unit: l.unit, value, pass };
	});
}

/** A timing taken with CPU idle below this share is provisional (apps/ampi/AGENTS.md). */
export const PROVISIONAL_IDLE_PCT = 50;

/** CPU idle over the run window and the worse memory pressure reading. Load average is context only. */
export function hostLoad(load = {}) {
	const levels = ["normal", "warn", "critical"];
	const memory = [load.memoryBefore?.level, load.memoryAfter?.level].filter(Boolean).sort((a, b) => levels.indexOf(b) - levels.indexOf(a))[0];
	const cpuIdlePct = load.cpuIdlePct;
	return { cpuIdlePct, memory, memoryFreePct: load.memoryAfter?.freePct, provisional: cpuIdlePct === undefined || cpuIdlePct < PROVISIONAL_IDLE_PCT || (memory !== undefined && memory !== "normal") };
}

/** Flat numbers for `perf compare`. */
export function metrics(summary) {
	const out = {};
	for (const [k, v] of Object.entries(summary.milestones)) out[`milestone ${k} ms`] = v;
	if (summary.run.scenario === "app") for (const [k, v] of Object.entries(summary.scenario?.stats ?? {})) out[`app ${k} ms`] = v;
	for (const l of summary.limits) if (typeof l.value === "number") out[`limit ${l.id}`] = l.value;
	out["shutdown ms"] = summary.external.shutdownMs;
	out["peak rss MB"] = summary.memory.peakRssMb;
	out["idle rss MB"] = summary.memory.idleRssMb;
	for (const t of summary.threads) {
		if (t.cpuBusyMs !== undefined) out[`cpu busy ${t.thread} ms`] = t.cpuBusyMs;
		if (t.gcMs) out[`gc ${t.thread} ms`] = t.gcMs;
	}
	for (const s of summary.spans.slice(0, 12)) out[`span ${s.cat}:${s.name} ms`] = s.totalMs;
	for (const s of summary.sqlite.slice(0, 5)) out[`sqlite ${s.name} ms`] = s.totalMs;
	return Object.fromEntries(Object.entries(out).filter(([, v]) => typeof v === "number" && Number.isFinite(v)));
}

// ---- rendering ----

const cell = (v) => (v === undefined || v === null ? "–" : String(v));
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
const SPARK = "▁▂▃▄▅▆▇█";
/** At most `width` bars; a long run averages neighbouring seconds into one bar. */
const spark = (values, width = 60) => {
	const size = Math.max(1, Math.ceil(values.length / width));
	const bars = [];
	for (let i = 0; i < values.length; i += size) {
		const bin = values.slice(i, i + size);
		bars.push(bin.reduce((a, b) => a + b, 0) / bin.length);
	}
	const max = bars.reduce((m, v) => Math.max(m, v), 1);
	return bars.map((v) => SPARK[Math.min(7, Math.floor((v / max) * 7))]).join("");
};

/** One screen: verdicts first, then where the time went. */
/** The driver's own record, one line: `key value` per scalar, nested objects as `key.sub`. */
function flatStats(stats, prefix = "") {
	return Object.entries(stats).map(([k, v]) => (v && typeof v === "object" ? flatStats(v, `${prefix}${k}.`) : `${prefix}${k} ${v}`)).join(" · ");
}

export function renderSummary(s) {
	const verdict = (p) => (p === null ? "no data" : p ? "pass" : "FAIL");
	const lines = [
		`# AmPi perf: ${s.run.scenario ?? "?"} on ${s.run.fixture ?? "?"}`,
		...(s.scenario?.ok === false ? [`**Scenario failed:** ${s.scenario.error ?? "no reason given"}`, ""] : []),
		...(s.host?.provisional ? [`**Provisional:** CPU idle ${cell(s.host.cpuIdlePct)}% (gate ≥ ${PROVISIONAL_IDLE_PCT}%), memory ${s.host.memory ?? "unknown"}.`, ""] : []),
		`${s.run.commit?.slice(0, 10) ?? "?"}${s.run.dirty ? "+dirty" : ""} · node ${s.run.node ?? "?"} · CPU idle ${cell(s.host?.cpuIdlePct)}% · memory ${s.host?.memory ?? "?"} · load ${cell(s.run.loadBefore)}→${cell(s.run.loadAfter)} · trace ${s.run.trace === false ? "off" : "on"} · driver ${s.run.driver ?? "?"}`,
		"",
		table(["Limit", "Target", "Value", "Result"], s.limits.map((l) => [l.label, `${l.target} ${l.unit}`, l.value, verdict(l.pass)])),
		"",
		`Milestones (ms from spawn): ${Object.entries(s.milestones).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
		"",
		table(["Phase (hub main)", "ms", "traced ms", "top spans"], s.phases.map((p) => [`${p.from} → ${p.to}`, p.ms, p.tracedMs, p.top.map((t) => `${t.name} ${t.ms}`).join(", ")])),
		"",
		table(["Thread", "CPU busy", "idle", "traced", "ELD p99/max", "GC n/ms"], s.threads.slice(0, 6).map((t) => [t.thread, t.cpuBusyMs, t.cpuIdleMs, t.tracedMs, `${cell(t.eldP99)}/${cell(t.eldMax)}`, `${t.gcCount}/${t.gcMs}`])),
		"",
		`Top spans (total ms): ${s.spans.slice(0, 6).map((x) => `${x.name} ${x.totalMs} (${x.count}×, self ${x.selfMs})`).join(" · ")}`,
		`Top SQLite (ms): ${s.sqlite.slice(0, 4).map((x) => `${x.name.slice(0, 48)} ${x.totalMs} (${x.count}×)`).join(" · ") || "–"}`,
		`Top functions (self ms): ${s.functions.slice(0, 6).map((f) => `${f.fn} ${f.selfMs} [${f.thread.split("/")[1]}]`).join(" · ") || "–"}`,
		`Memory: peak RSS ${cell(s.memory.peakRssMb)} MB, idle ${cell(s.memory.idleRssMb)} MB · shutdown ${cell(s.external.shutdownMs)} ms${s.external.shutdownForced ? " (forced)" : ""}`,
	];
	if (s.switches.first || s.switches.revisit) lines.push(`Switches: first ${JSON.stringify(s.switches.first ?? {})} · revisit ${JSON.stringify(s.switches.revisit ?? {})}`);
	if (s.external.loopWallMs !== undefined) lines.push(`Loop: wall ${cell(s.external.loopWallMs)} ms · setup ${cell(s.external.setupMs)} · lock wait ${cell(s.external.lockWaitMs)} (not in wall) · clone ${cell(s.external.cloneMs)} · report ${cell(s.external.reportMs)} ms`);
	if (s.scenario?.stats) lines.push(`Driver: ${flatStats(s.scenario.stats)}`);
	if (s.index) lines.push(`Cold index: ${s.index.jobs} jobs in ${cell(s.index.seconds)} s · rate first ${cell(s.index.firstRate)}/s, last ${cell(s.index.lastRate)}/s · ${spark(s.index.perSecond ?? [])}`);
	return `${lines.join("\n")}\n`;
}

/** Merges traces (adding CPU stacks as companion tracks), writes trace.json, summary.json, summary.md. */
export function report(runDir, { extraReceipt } = {}) {
	const run = loadRun(runDir);
	if (extraReceipt) Object.assign(run.receipt, extraReceipt);
	const summary = analyze(run);
	const label = threadNames(run.events);
	const merged = [...run.events];
	// V8 profiles of one process share its monotonic clock. A thread whose short clock-sync spin got no sample takes the
	// shift of a sibling thread.
	const shifts = run.profiles.map((p) => profileShift(run.events, p.profile, p.pid, p.tid));
	for (const [i, p] of run.profiles.entries()) {
		const shiftUs = shifts[i] ?? shifts.find((s, j) => s !== undefined && run.profiles[j].pid === p.pid);
		if (shiftUs === undefined) continue;
		const tid = 1000 + p.tid;
		merged.push({ ph: "M", pid: p.pid, tid, name: "thread_name", ts: 0, args: { name: `${label(p.pid, p.tid).split("/")[1]} cpu samples` } });
		for (const event of profileToEvents(p.profile, { pid: p.pid, tid, shiftUs })) merged.push(event);
	}
	writeFileSync(join(runDir, "trace.json"), JSON.stringify({ traceEvents: merged, displayTimeUnit: "ms" }));
	return writeSummary(runDir, summary);
}

/** Recomputes the verdicts (the runner adds the loop wall last) and writes summary.json and summary.md. */
export function writeSummary(runDir, summary) {
	summary.limits = checkLimits(summary);
	summary.metrics = metrics(summary);
	writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	writeFileSync(join(runDir, "summary.md"), renderSummary(summary));
	return summary;
}
