// Run-group aggregation and A/B comparison. Inputs are summary.json files written by report.mjs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS, median, PROVISIONAL_IDLE_PCT } from "./report.mjs";

/** Metrics where a larger value is better. All others are times, sizes, or counts: smaller is better. */
const HIGHER_IS_BETTER = new Set(["limit index-rate-tail", "limit index-complete"]);
const round = (v, digits = 1) => (v === undefined ? undefined : Math.round(v * 10 ** digits) / 10 ** digits);

/** One line of host context: CPU idle across runs and how many runs are provisional. */
export function hostLine(summaries) {
	const idle = summaries.map((s) => s.host?.cpuIdlePct).filter((v) => typeof v === "number");
	const provisional = summaries.filter((s) => s.host?.provisional !== false).length;
	const memory = [...new Set(summaries.map((s) => s.host?.memory ?? "unknown"))].join("/");
	const range = idle.length ? `median ${round(median(idle))}%, ${round(idle.reduce((m, v) => Math.min(m, v), Infinity))}–${round(idle.reduce((m, v) => Math.max(m, v), -Infinity))}%` : "not recorded";
	return `CPU idle ${range} · memory ${memory} · provisional ${provisional}/${summaries.length} (CPU idle < ${PROVISIONAL_IDLE_PCT}% or memory pressure)`;
}

/** Per metric: median, min, max, n. Per limit: pass count over runs with data. */
export function summarizeGroup(summaries) {
	const values = new Map();
	for (const s of summaries) for (const [k, v] of Object.entries(s.metrics ?? {})) values.set(k, [...(values.get(k) ?? []), v]);
	const metrics = {};
	for (const [k, vs] of values) {
		const mid = median(vs);
		metrics[k] = { median: round(mid, 2), mad: round(median(vs.map((v) => Math.abs(v - mid))), 2), min: Math.min(...vs), max: Math.max(...vs), n: vs.length };
	}
	const limits = {};
	for (const s of summaries)
		for (const l of s.limits ?? []) {
			const row = (limits[l.id] ??= { id: l.id, label: l.label, target: l.target, unit: l.unit, pass: 0, fail: 0, noData: 0, values: [] });
			if (l.pass === null) row.noData++;
			else if (l.pass) row.pass++;
			else row.fail++;
			if (typeof l.value === "number") row.values.push(l.value);
		}
	for (const row of Object.values(limits)) {
		row.median = row.values.length ? round(median(row.values), 2) : undefined;
		row.max = row.values.length ? Math.max(...row.values) : undefined;
		delete row.values;
	}
	return { runs: summaries.length, scenarioOk: summaries.filter((s) => s.scenario?.ok !== false).length, metrics, limits: Object.values(limits) };
}

const cell = (v) => (v === undefined || v === null ? "–" : String(v));
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

/** The group screen: per-limit pass counts first, then per-run values and the main metric medians. */
export function renderGroup(label, summaries, aggregate) {
	const order = new Map(LIMITS.map((l, i) => [l.id, i]));
	const limits = [...aggregate.limits].sort((a, b) => order.get(a.id) - order.get(b.id));
	const verdict = (l) => (l.fail ? `FAIL ${l.fail}/${aggregate.runs}` : l.pass ? `pass ${l.pass}/${aggregate.runs}` : "no data");
	const lines = [
		`# AmPi perf group: ${label} (${aggregate.runs} runs)`,
		"",
		hostLine(summaries),
		"",
		table(["Limit", "Target", "Median", "Worst", "Result"], limits.map((l) => [l.label, `${l.target} ${l.unit}`, l.median, l.id.startsWith("index-") ? undefined : l.max, verdict(l)])),
		"",
		table(["Run", ...limits.map((l) => l.id)], summaries.map((s, i) => [`r${String(i + 1).padStart(2, "0")}`, ...limits.map((l) => {
			const own = s.limits.find((x) => x.id === l.id);
			return own ? `${cell(own.value)}${own.pass === false ? " ✗" : ""}` : undefined;
		})])),
		"",
		table(["Metric", "median", "min", "max"], Object.entries(aggregate.metrics).filter(([k]) => !k.startsWith("limit ")).slice(0, 24).map(([k, m]) => [k, m.median, round(m.min, 2), round(m.max, 2)])),
	];
	return `${lines.join("\n")}\n`;
}

/** A group directory (group.json + rNN/summary.json) or one run directory → its summaries. */
export function loadSummaries(dir) {
	if (existsSync(join(dir, "group.json"))) {
		const group = JSON.parse(readFileSync(join(dir, "group.json"), "utf8"));
		return group.runs.map((r) => join(dir, r, "summary.json")).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")));
	}
	if (existsSync(join(dir, "summary.json"))) return [JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"))];
	throw new Error(`No group.json or summary.json in ${dir}`);
}

/**
 * Per metric: median A, median B, delta, and a verdict. Noise is 2 × the larger median absolute deviation (MAD) of
 * the two sides, so one outlier run cannot hide a shift. A delta inside the noise is "≈". One-run sides have no
 * spread, so their verdicts rest on the delta alone.
 */
export function compareSummaries(a, b) {
	const ga = summarizeGroup(a);
	const gb = summarizeGroup(b);
	const rows = [];
	for (const key of new Set([...Object.keys(ga.metrics), ...Object.keys(gb.metrics)])) {
		const ma = ga.metrics[key];
		const mb = gb.metrics[key];
		if (!ma || !mb) {
			rows.push({ metric: key, a: ma?.median, b: mb?.median, verdict: "only one side" });
			continue;
		}
		const delta = mb.median - ma.median;
		const noise = 2 * Math.max(ma.mad, mb.mad);
		const better = HIGHER_IS_BETTER.has(key) ? delta > 0 : delta < 0;
		const verdict = delta === 0 || Math.abs(delta) <= noise ? "≈" : better ? "better" : "worse";
		rows.push({ metric: key, a: ma.median, b: mb.median, delta: round(delta, 2), pct: ma.median ? round((delta / ma.median) * 100) : undefined, noise: round(noise, 2), verdict });
	}
	const rank = { worse: 0, better: 1, "≈": 2, "only one side": 3 };
	rows.sort((x, y) => rank[x.verdict] - rank[y.verdict] || Math.abs(y.pct ?? 0) - Math.abs(x.pct ?? 0));
	return { runsA: a.length, runsB: b.length, rows };
}

export function compareDirs(dirA, dirB) {
	if (!dirA || !dirB) throw new Error("usage: perf compare <runA|groupA> <runB|groupB>");
	const a = loadSummaries(dirA), b = loadSummaries(dirB);
	const result = compareSummaries(a, b);
	const lines = [
		`# AmPi perf compare: A ${result.runsA} runs → B ${result.runsB} runs`,
		"",
		`A: ${hostLine(a)}`,
		`B: ${hostLine(b)}`,
		"",
		"Noise is 2 × the larger median absolute deviation of the two sides. A delta inside it is ≈.",
		"",
		table(["Metric", "A median", "B median", "Δ", "Δ %", "noise", "verdict"], result.rows.map((r) => [r.metric, r.a, r.b, r.delta, r.pct, r.noise, r.verdict])),
	];
	return `${lines.join("\n")}\n`;
}
