import "./bound.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, replaceFile } from "./pi-fixtures.ts";

// A test and a fake CLI read each other's files while both run. An in-place write truncates the file first, so a
// concurrent reader can parse half of it (failure: the fake Herdr crashed on a truncated state.json, and the agent
// reported "Herdr session default not running"). A replaced file never changes under a reader: a reader that
// opened it before a write still reads the old whole file. An in-place write fails this check on every run.
const readsWhole = (file: string, write: () => void) => {
	const before = readFileSync(file, "utf8"), fd = openSync(file, "r");
	try {
		write();
		assert.equal(readFileSync(fd, "utf8"), before, `a reader that opened ${file} before the write reads the old whole file`);
	} finally {
		closeSync(fd);
	}
	return JSON.parse(readFileSync(file, "utf8"));
};

const herdr = (f: ReturnType<typeof fixture>, ...args: string[]) => {
	const run = spawnSync(join(f.dir, "herdr"), args, { env: { ...process.env, FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") }, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
};

test("fixture files: every writer of the fake Herdr's state replaces it, so a concurrent reader never sees a partial file", () => {
	const f = fixture(), state = join(f.dir, "state.json");
	assert.equal(readsWhole(state, () => replaceFile(state, JSON.stringify({ ...f.state, step: 1 }))).step, 1, "replaceFile");
	assert.equal(readsWhole(state, () => f.setState({ ...f.state, step: 2 })).step, 2, "the test's setState");
	const renamed = readsWhole(state, () => herdr(f, "pane", "rename", "w1:p1", "renamed"));
	assert.equal(renamed.agents.find((p: any) => p.pane_id === "w1:p1").label, "renamed", "the fake Herdr's save");
	assert.deepEqual(readdirSync(f.dir).filter((name) => name.endsWith(".tmp")), [], "no temp file stays behind");
});

test("fixture files: a log reader counts a record only after its newline, so a write in progress is never parsed", () => {
	const f = fixture(), log = join(f.dir, "calls.jsonl");
	herdr(f, "pane", "rename", "w1:p1", "renamed");
	assert.deepEqual(f.herdrCalls(), [["pane", "rename", "w1:p1", "renamed"]]);
	appendFileSync(log, '["pane","ren');
	assert.equal(f.herdrCalls().length, 1, "a partial record is not yet a record");
	appendFileSync(log, 'ame","w1:p2","x"]\n');
	assert.deepEqual(f.herdrCalls().at(-1), ["pane", "rename", "w1:p2", "x"]);
});
