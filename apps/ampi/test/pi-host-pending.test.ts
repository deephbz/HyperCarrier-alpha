import "./bound.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { iso, line, setup, user } from "./pi-host-fixtures.ts";

test("a thread subscription opened before the Host lists its Session stays open and gets the transcript when the Session appears", async (t) => {
	const { f, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]);
	const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-late" });
	const view = browser.sub("devbox", { kind: "view", view: "rarebit", threadId: "pi:sess-late" });
	await browser.when(() => browser.closing.has(thread), 5_000, "a pending frame");
	// The Host has listed its Sessions, so the id is missing: a clear not-found that still recovers.
	assert.deepEqual(browser.closing.get(thread), { t: "pending", reason: "Unknown Session on this Host" });

	writeFileSync(join(f.sessionA, "..", "late.jsonl"), line({ type: "session", version: 3, id: "sess-late", timestamp: iso(0), cwd: "/work" }) + user("l1", null, 1, "arrived late"));
	const value = await browser.until<any>(thread, (v) => v.entries.length === 1, 5_000);
	assert.equal(value.entries[0].text, "arrived late");
	await browser.until(view, () => true, 5_000);
	assert.deepEqual(browser.gaps, []);
});

test("before the Host's first Session list, an unknown Session is looked for, not reported missing", async (t) => {
	// A Herdr that answers only `--version` holds back the first list for the 3 s session-check timeout.
	// It must answer `--version`, or the agent falls back to the real Herdr on PATH.
	const home = mkdtempSync(join(tmpdir(), "ampi-slow-herdr-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const bin = join(home, "herdr");
	writeFileSync(bin, '#!/bin/sh\n[ "$1" = --version ] && exit 0\nsleep 30\n');
	chmodSync(bin, 0o755);
	const { browser } = await setup(t, { env: { HOME: home, HERDR_BIN: bin } });
	const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
	await browser.when(() => browser.closing.has(thread), 2_500, "a pending frame");
	assert.deepEqual(browser.closing.get(thread), { t: "pending", reason: "Looking for this Session on the Host…" });
	const value = await browser.until<any>(thread, (v) => v.entries.length > 0, 10_000);
	assert.equal(value.entries[0].text, "list the files");
});
