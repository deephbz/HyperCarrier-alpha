import "./bound.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { CrashChild } from "./durable-l2/process.ts";
import { tempHome } from "./helpers.ts";

// A failed named command fails only its own waits, so a journey can record one failed step and continue.
test("a named child failure rejects waits for that name and leaves other waits alive", async () => {
	const dir = tempHome(), fixture = join(dir, "fixture.mjs");
	writeFileSync(fixture, `
process.on("message", m => {
	if (m.command === "fail") process.send({ type: "failure", value: "synthetic", name: m.name });
	else if (m.command === "ping") process.send({ type: "pong", name: m.name });
	else if (m.command === "crash") process.send({ type: "failure", value: "unnamed" });
});
process.send({ type: "ready" });
`);
	const child = new CrashChild(dir, "failure", "a", pathToFileURL(fixture));
	await child.wait("ready");
	child.child.send({ command: "fail", name: "first" });
	await assert.rejects(child.wait("never", "first"), /child failure: synthetic/);
	child.child.send({ command: "ping", name: "second" });
	assert.equal((await child.wait("pong", "second")).name, "second");
	child.child.send({ command: "crash" });
	await assert.rejects(child.wait("pong", "third"), /child failure: unnamed/);
	await assert.rejects(child.result(), /child failure: unnamed/);
	child.child.kill();
	await child.exited;
});
