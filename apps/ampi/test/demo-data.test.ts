import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { demoDataMode } from "../scripts/demo/data/modes.ts";
import { demoFixtures } from "../scripts/demo/data/registry.ts";
import { CONTENT_FIND_QUERY } from "../scripts/demo/data/content.ts";
import { writeContentSessions } from "../scripts/demo/data/registry.ts";

const app = join(import.meta.dirname, "..");

test("demo fixture option accepts known values and defaults to demo", () => {
	assert.equal(demoDataMode(), "demo");
	assert.equal(demoDataMode(["--fixture", "worst"]), "worst");
	assert.equal(demoDataMode(["--fixture", "empty"]), "empty");
	assert.equal(demoDataMode(["--fixture", "one"]), "one");
	assert.equal(demoDataMode(["--fixture", "huge"]), "huge");
	assert.throws(() => demoDataMode(["--fixture", "unexpected"]), /Unknown demo fixture/);
	assert.throws(() => demoDataMode(["--fixture"]), /requires a value/);
	assert.throws(() => demoDataMode(["--fixture", "worst", "--fixture", "demo"]), /only once/);
	assert.throws(() => demoDataMode(["--data", "worst"]), /Unknown demo option/);
});

test("demo fixture registry merges named contributors and selects empty/one list shapes", () => {
	const base = [{ name: "base", file: "/base.jsonl", id: "base", cwd: "/work" }];
	const content = [{ name: "content", file: "/content.jsonl", id: "content", cwd: "/work" }];
	assert.deepEqual(demoFixtures("demo", base, [{ sessions: content }]).sessions, [...base, ...content]);
	assert.deepEqual(demoFixtures("empty", base, [{ sessions: content }]).sessions, []);
	assert.deepEqual(demoFixtures("one", base, [{ sessions: content }]).sessions, content);
});

test("worst content fixture writes realistic search hits at the demo data boundary", () => {
	const root = mkdtempSync(join(tmpdir(), "ampi-demo-data-"));
	try {
		const rows = writeContentSessions(join(root, "agent"), 1_800_000_000_000, "worst");
		assert.equal(rows.length, 1);
		const source = readFileSync(rows[0]!.file, "utf8");
		assert.equal(source.split(CONTENT_FIND_QUERY).length - 1, 220);
		assert.match(source, /نور الهدى/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("one and huge content modes write one and 1,200 transcript entries", () => {
	const root = mkdtempSync(join(tmpdir(), "ampi-demo-shapes-"));
	try {
		for (const [mode, count] of [["one", 1], ["huge", 1_200]] as const) {
			const row = writeContentSessions(join(root, mode), 1_800_000_000_000, mode)[0]!;
			const entries = readFileSync(row.file, "utf8").trimEnd().split("\n").slice(1);
			assert.equal(entries.length, count, `${mode} transcript entries`);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("live hub ignores the demo-only fixture option", () => {
	const hub = readFileSync(join(app, "src/hub/hub.ts"), "utf8");
	const entry = readFileSync(join(app, "bin/ampi.mjs"), "utf8");
	const demo = readFileSync(join(app, "scripts/pi-demo.ts"), "utf8");
	assert.match(demo, /demoDataMode\(process\.argv\.slice\(2\)\)/);
	assert.match(demo, /demoFixtures\(dataMode/);
	assert.doesNotMatch(hub, /--fixture|demo\/data/);
	assert.doesNotMatch(entry, /--fixture|demo\/data/);
});
