import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cosDemo } from "../scripts/demo/cos.ts";
import { demoStressConfig } from "../scripts/demo/data/stress.ts";

test("huge demo stress defaults stay stable and accept bounded session and entry counts", () => {
	assert.deepEqual(demoStressConfig("huge", undefined, undefined), { sessions: 1000, entriesPerSession: 96 });
	assert.deepEqual(demoStressConfig("huge", "2", "4"), { sessions: 2, entriesPerSession: 4 });
	assert.deepEqual(demoStressConfig("worst", "0", "4"), { sessions: 0, entriesPerSession: 4 });
});

test("demo stress writes the requested number of Sessions and transcript entries", () => {
	const root = mkdtempSync(join(tmpdir(), "ampi-demo-stress-"));
	const before = { count: process.env.DEMO_STRESS, entries: process.env.DEMO_STRESS_ENTRIES_PER_SESSION };
	try {
		process.env.DEMO_STRESS = "2";
		process.env.DEMO_STRESS_ENTRIES_PER_SESSION = "4";
		cosDemo({ dir: root, agentDir: join(root, "agent"), now: 1_800_000_000_000, sessions: {}, dataMode: "huge" });
		const dir = join(root, "agent/sessions/--work-stress--");
		const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
		assert.equal(files.length, 2);
		for (const file of files) {
			const records = readFileSync(join(dir, file), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
			assert.equal(records.length - 1, 4, `${file} entries per Session`);
		}
	} finally {
		if (before.count === undefined) delete process.env.DEMO_STRESS; else process.env.DEMO_STRESS = before.count;
		if (before.entries === undefined) delete process.env.DEMO_STRESS_ENTRIES_PER_SESSION; else process.env.DEMO_STRESS_ENTRIES_PER_SESSION = before.entries;
		rmSync(root, { recursive: true, force: true });
	}
});
