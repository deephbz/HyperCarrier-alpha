#!/usr/bin/env node
// Trial-week measurement: record a bounded phys_footprint series; report its slopes and the step 6 stop verdict.
// The sampler owns process roles. Split rows keep hub, Pi host agents, node and other helpers separate.
// Legacy three-column rows retain their hub-tree meaning; they cannot prove the hub-alone or hub+node limits.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sampleTrees } from "../../test/durable-l4/memory.mjs";

const FOOTPRINT = fileURLToPath(new URL("../../test/durable-l4/footprint.py", import.meta.url));
/** Runbook step 6 targets under real load, in MB (1e6 bytes). */
export const LIMITS = { hub: 450, total: 800 };
const HEADER = "time,hub_MB,agent_MB,node_MB,helpers_MB";
const LEGACY_HEADER = "time,hub_MB,node_MB";

/** One sample of the live trees: the hub is the listener on `hubPort`, the node the PID in `nodePidFile`. */
export function sampleLive(hubPort, nodePidFile) {
	const hub = Number(execFileSync("lsof", ["-t", `-iTCP:${hubPort}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0]);
	const node = Number(readFileSync(nodePidFile, "utf8").trim());
	const { totals } = sampleTrees(FOOTPRINT, { hub, node });
	return { hub: totals.hub / 1e6, agent: totals.agent / 1e6, node: totals.node / 1e6, helpers: totals.helpers / 1e6 };
}

/** Appends `count` rows to `out`, one every `everyMs`. A failed sample writes no row; its reason goes to stderr. */
export async function record({ out, everyMs, count, sample, now = () => new Date() }) {
	if (!existsSync(out)) writeFileSync(out, `${HEADER}\n`, { mode: 0o600 });
	else if (readFileSync(out, "utf8").split("\n")[0] !== HEADER)
		throw new Error("Cannot append split samples to a legacy or unknown CSV. Use a new output file.");
	for (let i = 0; i < count; i++) {
		if (i > 0) await sleep(everyMs);
		const at = now().toISOString();
		try {
			const { hub, agent, node, helpers } = sample();
			const values = [hub, agent, node, helpers];
			if (!values.every((value) => Number.isFinite(value) && value >= 0)) throw new Error("invalid footprint totals");
			appendFileSync(out, `${at},${values.map((value) => value.toFixed(1)).join(",")}\n`);
		} catch (error) {
			console.error(`${at} no sample: ${error.message}`);
		}
	}
}

export function parseSeries(text) {
	const [header, ...lines] = text.trim().split("\n");
	const legacy = header === LEGACY_HEADER;
	if (!legacy && header !== HEADER) throw new Error(`not a memory series: expected ${HEADER} or ${LEGACY_HEADER}`);
	return lines.map((line, index) => {
		const [time, ...cells] = line.split(",");
		const at = Date.parse(time), values = cells.map(Number);
		if (!Number.isFinite(at) || cells.length !== (legacy ? 2 : 4) || cells.some((cell) => !cell.trim()) || !values.every((value) => Number.isFinite(value) && value >= 0))
			throw new Error(`invalid memory sample at line ${index + 2}`);
		return legacy ? { at, hubTree: values[0], node: values[1] }
			: { at, hub: values[0], agent: values[1], node: values[2], helpers: values[3] };
	});
}

/** Least-squares slope of `value` over hours. */
function slope(rows, value) {
	const xs = rows.map((row) => (row.at - rows[0].at) / 3.6e6);
	const ys = rows.map(value);
	const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
	const my = ys.reduce((a, b) => a + b, 0) / ys.length;
	const sxx = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
	return sxx === 0 ? 0 : xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / sxx;
}

/** The report lines and the verdict. `stop` holds the reasons to run step 7; empty means record the slope. */
export function report(rows, trialEnd) {
	if (rows.length < 2) throw new Error(`a slope needs 2 samples; the series has ${rows.length}`);
	const first = rows[0], last = rows.at(-1);
	const hoursLeft = Math.max(0, (trialEnd - last.at) / 3.6e6);
	const legacy = "hubTree" in first;
	if (rows.some((row) => ("hubTree" in row) !== legacy)) throw new Error("cannot mix legacy hub-tree and split samples");
	const series = legacy ? [
		{ name: "legacy hub-tree", value: (row) => row.hubTree, limit: LIMITS.total },
		{ name: "node", value: (row) => row.node },
	] : [
		{ name: "hub", value: (row) => row.hub, limit: LIMITS.hub },
		{ name: "agent", value: (row) => row.agent },
		{ name: "node", value: (row) => row.node },
		{ name: "helpers", value: (row) => row.helpers },
		{ name: "hub+agent", value: (row) => row.hub + row.agent, limit: LIMITS.total },
		{ name: "hub+node", value: (row) => row.hub + row.node, limit: LIMITS.total },
	];
	const lines = [`samples ${rows.length} over ${((last.at - first.at) / 3.6e6).toFixed(1)} h, ${new Date(first.at).toISOString()} to ${new Date(last.at).toISOString()}; ${hoursLeft.toFixed(1)} h left in the trial week`];
	if (legacy) lines.push("Legacy CSV: hub_MB includes hub descendants. Only the 800 MB legacy hub-tree ceiling is checked; hub-alone and hub+node are unknown.");
	const stop = [];
	for (const { name, value, limit } of series) {
		const perHour = slope(rows, value);
		const projected = value(last) + perHour * hoursLeft;
		const peak = Math.max(...rows.map(value));
		lines.push(`${name}: first ${value(first).toFixed(1)} MB, last ${value(last).toFixed(1)} MB, peak ${peak.toFixed(1)} MB, slope ${perHour.toFixed(2)} MB/h` +
			(limit ? `, projected ${projected.toFixed(1)} MB at the trial end (limit ${limit} MB)` : ""));
		if (!limit) continue;
		if (peak > limit) stop.push(`a ${name} sample reached ${peak.toFixed(1)} MB, above ${limit} MB`);
		else if (projected > limit) stop.push(`the ${name} slope projects ${projected.toFixed(1)} MB at the trial end, above ${limit} MB`);
	}
	lines.push(stop.length ? `STOP: run runbook step 7. ${stop.join("; ")}.` : "RECORD: no checked limit is reached or projected. Record the slope as D21 evidence in trial-week.md.");
	return { lines, stop };
}

function option(args, name, fallback) {
	const at = args.indexOf(name);
	if (at < 0) {
		if (fallback === undefined) throw new Error(`${name} is required`);
		return fallback;
	}
	return args[at + 1];
}

async function main(args) {
	const [command, ...rest] = args;
	if (command === "record") {
		const out = option(rest, "--out");
		const hubPort = option(rest, "--hub-port", "7879");
		const nodePidFile = option(rest, "--node-pid-file", join(homedir(), ".ampi", "node.pid"));
		await record({ out, everyMs: Number(option(rest, "--every", "600")) * 1000, count: Number(option(rest, "--count", "145")), sample: () => sampleLive(hubPort, nodePidFile) });
		return 0;
	}
	if (command === "report") {
		const trialEnd = Date.parse(option(rest, "--trial-end"));
		if (Number.isNaN(trialEnd)) throw new Error("--trial-end needs a date, for example 2026-11-01T09:00+08:00");
		const { lines, stop } = report(parseSeries(readFileSync(rest[0], "utf8")), trialEnd);
		console.log(lines.join("\n"));
		return stop.length ? 1 : 0;
	}
	console.error("usage: memory-series.mjs record --out FILE [--every SECONDS] [--count N] [--hub-port PORT] [--node-pid-file FILE]\n       memory-series.mjs report FILE --trial-end DATE");
	return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then((code) => (process.exitCode = code), (error) => {
		console.error(error.message);
		process.exitCode = 2;
	});
}
