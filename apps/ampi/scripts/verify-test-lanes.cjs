#!/usr/bin/env node
// Checks that every AmPi test file has one lane, its bound and its export entry, and repairs a gap:
//
//   node apps/ampi/scripts/verify-test-lanes.cjs                                     check the lane and export closure
//   node apps/ampi/scripts/verify-test-lanes.cjs --register <name.test.ts> <lane>    add the lane row and export entry
//   node apps/ampi/scripts/verify-test-lanes.cjs --where <name.test.ts>              print its lane, cost and export state
//
// The lanes and the export manifest are the merged views of the shared files and their line fragments
// (scripts/lib/line-fragments.cjs). In a checkout with the durable fragments, --register writes the fragments and
// --register ... --shared writes the shared files; elsewhere --register writes the shared files.
require("./stdio-sync.cjs");
const fs = require("node:fs");
const path = require("node:path");
const fragments = require("../../../scripts/lib/line-fragments.cjs");

const root = path.resolve(__dirname, "..");
const repo = path.resolve(root, "../..");
const lanesPath = path.join(root, "test-lanes.json");
const exportPath = path.join(repo, "release/public/export-manifest.json");
const write = (file, document) => fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
let lanes, registration;
const loadExports = () => fragments.loadExportManifest(exportPath, { root: repo, relativePath: "release/public/export-manifest.json" });
try {
	lanes = fragments.loadTestLanes(lanesPath, { root: repo });
	registration = fragments.ampiRegistration(repo);
} catch (error) {
	console.error(`Line fragment error: ${error.message}`);
	process.exit(1);
}
const manifest = lanes.lanes;
function testLanesEntry(exports) {
	const entry = exports.entries?.find((entry) => entry.to === "apps/ampi/test-lanes.json");
	if (entry?.kind !== "test-lanes" || !Array.isArray(entry.omit)) {
		console.error('Export manifest schema error: apps/ampi/test-lanes.json requires kind "test-lanes" and an omit array.');
		process.exit(1);
	}
	return entry;
}
function exportsOrExit() {
	try {
		return loadExports();
	} catch (error) {
		console.error(`Line fragment error: ${error.message}`);
		process.exit(1);
	}
}
const usage = `Usage: node apps/ampi/scripts/verify-test-lanes.cjs --register <name.test.ts> <fast|exhaustiveOnly>${registration.fragments ? " [--shared]" : ""}`;
const testName = (file) => /^[\w.-]+\.test\.ts$/.test(file ?? "");

if (process.argv[2] === "--where") {
	const [, file, ...extra] = process.argv.slice(2);
	if (!testName(file) || extra.length) {
		console.error("Usage: node apps/ampi/scripts/verify-test-lanes.cjs --where <name.test.ts>");
		process.exit(1);
	}
	where(file);
	process.exit(0);
}
if (process.argv.length > 2) {
	const [action, file, lane, ...extra] = process.argv.slice(2);
	const shared = extra.length === 1 && extra[0] === "--shared";
	if (action !== "--register" || !testName(file) || !["fast", "exhaustiveOnly"].includes(lane) || (extra.length && !shared)) {
		console.error(usage);
		process.exit(1);
	}
	register(file, lane, !registration.fragments || shared);
	process.exit(0);
}

function register(file, lane, toShared) {
	if (!fs.statSync(path.join(root, "test", file)).isFile()) throw new Error(`Missing test/${file}`);
	const other = lane === "fast" ? "exhaustiveOnly" : "fast";
	if (manifest[other].includes(file)) throw new Error(`${file} is already in ${other}; move it explicitly before registration`);
	const exports = exportsOrExit();
	const source = `apps/ampi/test/${file}`;
	const lanesEntry = testLanesEntry(exports.manifest);
	if (lanesEntry?.omit?.includes(file)) throw new Error(`${file} is private-only; review its omit entry before registration`);
	const existing = exports.manifest.entries.find((entry) => entry.from === source || entry.to === source);
	if (existing && (existing.from !== source || existing.to !== source || existing.kind !== "file")) throw new Error(`${source} has a nonstandard export entry; review it before registration`);
	if (toShared) {
		const base = exports.base, baseLanes = lanes.base;
		if (!existing) {
			const sibling = base.entries.findLastIndex((entry) => entry.from.startsWith("apps/ampi/test/") && entry.from <= source);
			if (sibling < 0) throw new Error("No AmPi test export sibling found");
			base.entries.splice(sibling + 1, 0, { from: source, to: source, kind: "file" });
		}
		if (!manifest[lane].includes(file)) {
			const sibling = baseLanes[lane].findLastIndex((entry) => entry <= file);
			baseLanes[lane].splice(sibling + 1, 0, file);
		}
		write(lanesPath, baseLanes);
		write(exportPath, base);
		console.log(`Registered ${source} in ${lane} and release/public/export-manifest.json.`);
		return;
	}
	const exportFragment = exports.fragment, laneFragment = lanes.fragment;
	if (!existing) {
		exportFragment.entries ??= [];
		const sibling = exportFragment.entries.findLastIndex((entry) => entry.from.startsWith("apps/ampi/test/") && entry.from <= source);
		exportFragment.entries.splice(sibling < 0 ? exportFragment.entries.length : sibling + 1, 0, { from: source, to: source, kind: "file" });
	}
	if (!manifest[lane].includes(file)) {
		// The row goes after the last merged row that sorts before it: the shared files' sibling rule, on the merged view.
		const rows = manifest[lane];
		const at = rows.findLastIndex((entry) => entry <= file);
		const after = at < 0 ? null : rows[at];
		laneFragment.insert ??= {};
		const groups = (laneFragment.insert[lane] ??= []);
		const holder = groups.find((group) => group.files.includes(after));
		if (holder) holder.files.splice(holder.files.indexOf(after) + 1, 0, file);
		else {
			const anchored = groups.find((group) => group.after === after);
			if (anchored) anchored.files.unshift(file);
			else {
				const position = (row) => (row === null ? -1 : rows.indexOf(row));
				const next = groups.findIndex((group) => position(group.after) > at);
				groups.splice(next < 0 ? groups.length : next, 0, { after, files: [file] });
			}
		}
	}
	fragments.mergeTestLanes(lanes.base, laneFragment, { names: lanes.names });
	write(fragments.fragmentPath(lanesPath), laneFragment);
	write(fragments.fragmentPath(exportPath), exportFragment);
	console.log(`Registered ${source} in ${lane} in ${registration.lanesFile} and ${registration.manifestFile}.`);
}

// Which file holds each fact about one test: its lane row, its cost hint and its export state.
function where(file) {
	const [baseLanes, laneFragment] = [lanes.base, lanes.fragment];
	const [lanesBase, lanesFragment] = lanes.names;
	const source = `apps/ampi/test/${file}`;
	const inFragment = (lane) => (laneFragment?.insert?.[lane] ?? []).some((group) => group.files.includes(file));
	const retired = (laneFragment?.retire ?? []).includes(file);
	console.log(source);
	const lane = ["fast", "exhaustiveOnly"].find((name) => manifest[name].includes(file));
	if (lane) {
		const holder = inFragment(lane) ? (retired ? `${lanesFragment} moves it from ${lanesBase}` : lanesFragment) : lanesBase;
		console.log(`  lane: ${lane}, row ${manifest[lane].indexOf(file) + 1} of ${manifest[lane].length} (${holder})`);
	} else console.log(`  lane: none${retired ? ` (${lanesFragment} retires it)` : ""}`);
	const cost = manifest.costs?.[file];
	const costHolder = (laneFragment?.costs ?? []).some((group) => file in (group.costs ?? {})) ? lanesFragment : lanesBase;
	console.log(`  cost: ${cost === undefined ? "none (counts 1 s)" : `${cost} s (${costHolder})`}`);
	if (!fs.existsSync(exportPath)) {
		console.log("  exported: no source export manifest in this tree");
		return;
	}
	const exports = exportsOrExit();
	const [exportBase, exportFragment] = exports.names;
	const entry = exports.manifest.entries.find((candidate) => candidate.from === source);
	const omitted = (exports.fragment?.omit?.["apps/ampi/test-lanes.json"] ?? []).includes(file) ? exportFragment : (exports.base.entries.find((candidate) => candidate.to === "apps/ampi/test-lanes.json")?.omit ?? []).includes(file) ? exportBase : undefined;
	if (entry) console.log(`  exported: yes (${(exports.fragment?.entries ?? []).includes(entry) ? exportFragment : exportBase})`);
	else if ((exports.fragment?.retire ?? []).includes(source)) console.log(`  exported: no (${exportFragment} retires it)`);
	else if (omitted) console.log(`  exported: no, private-only (omitted in ${omitted})`);
	else console.log("  exported: no entry");
}

if (manifest.version !== 1 || !Array.isArray(manifest.fast) || !Array.isArray(manifest.exhaustiveOnly)) throw new Error("invalid test-lanes.json");
const actual = fs.readdirSync(path.join(root, "test")).filter((file) => file.endsWith(".test.ts")).sort();
const assigned = [...manifest.fast, ...manifest.exhaustiveOnly];
const duplicates = assigned.filter((file, index) => assigned.indexOf(file) !== index);
const missing = actual.filter((file) => !assigned.includes(file));
const unknown = assigned.filter((file) => !actual.includes(file));
// `costs` hints balance the CI shards (scripts/run-tests.cjs --shard); a hint for a file outside the lanes is stale.
const costs = manifest.costs ?? {};
const staleCosts = Object.keys(costs).filter((file) => !assigned.includes(file) || !(Number(costs[file]) > 0));
// test/bound.ts bounds a bare `node --test <file>` run only when the file imports it.
const unbounded = actual.filter((file) => !/^import (["'])\.\/bound\.ts\1;$/m.test(fs.readFileSync(path.join(root, "test", file), "utf8")));
// The public tree has no source export manifest; its projected lanes still close normally.
const exportManifest = fs.existsSync(exportPath) ? exportsOrExit().manifest : null;
const omitted = exportManifest ? testLanesEntry(exportManifest).omit : [];
const unexported = exportManifest ? actual.filter((file) => !omitted.includes(file) && !exportManifest.entries.some((entry) => entry.from === `apps/ampi/test/${file}` && entry.to === entry.from)) : [];
if (duplicates.length || missing.length || unknown.length || unbounded.length || staleCosts.length || unexported.length) {
	console.error(`Test lane closure failed: ${JSON.stringify({ duplicates, missing, unknown, unbounded, staleCosts, unexported })}`);
	for (const file of new Set([...missing, ...unexported])) {
		const lane = manifest.exhaustiveOnly.includes(file) ? "exhaustiveOnly" : "fast";
		console.error(`apps/ampi/test/${file}: ${missing.includes(file) ? "missing lane entry" : "missing export entry"}. Fix from repository root: ${registration.command(file, lane)}${missing.includes(file) ? " (use exhaustiveOnly for an exhaustive test)" : ""}${unexported.includes(file) ? `; for a private-only test, add ${JSON.stringify(file)} to ${registration.omitList}${missing.includes(file) ? ` and add it to the chosen lane in ${registration.lanesFile}` : ""}` : ""}`);
	}
	process.exit(1);
}
console.log(`Test lanes closed: ${manifest.fast.length} fast, ${manifest.exhaustiveOnly.length} exhaustive-only.`);
