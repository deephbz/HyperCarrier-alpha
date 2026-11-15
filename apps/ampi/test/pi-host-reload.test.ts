// A control that reloads (pi-hc-control self-update or /reload) leaves a "reloading" descriptor until its new
// endpoint opens. The Host's agent holds sends for that Session and never types them into the pane.
import "./bound.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { control, replaceFile } from "./pi-fixtures.ts";
import { controlStamp } from "../src/shared/build.ts";
import { setup } from "./pi-host-fixtures.ts";

const descriptorPath = (f: any) => join(f.agentDir, "hc-control", "sess-a.json");

/** sess-a's control goes away as a reload does: no socket, and its descriptor says "reloading" for `deadlineIn` ms. */
async function reloading(t: any, { deadlineIn, ...fields }: { deadlineIn: number; pid?: number }) {
	const { f, browser } = await setup(t);
	const ctl = await control(f, f.sessionA);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true);
	const live = JSON.parse(readFileSync(descriptorPath(f), "utf8"));
	ctl.close();
	await new Promise((resolve) => setTimeout(resolve, 100));
	replaceFile(descriptorPath(f), JSON.stringify({ ...live, state: "reloading", targetStamp: controlStamp(), deadline: Date.now() + deadlineIn, ...fields }));
	const send = (content: string) => browser.req("devbox", "thread.submit", { threadId: "pi:sess-a", content, whenBusy: "steer" });
	const keys = () => f.herdrCalls().filter((c: string[]) => c.some((a) => a.includes("held")));
	return { f, browser, send, keys };
}

test("pi host: a send during a control reload waits for the reloaded endpoint and never becomes keys", async (t) => {
	const { f, send, keys } = await reloading(t, { deadlineIn: 10_000 });
	const first = send("held one");
	const second = send("held two");
	await new Promise((resolve) => setTimeout(resolve, 800));
	assert.deepEqual(keys(), [], "a held send reached the pane as keys");

	const next = await control(f, f.sessionA, { nonce: "n-reloaded" });
	t.after(() => next.close());
	assert.deepEqual([await first, await second].map((r: any) => r.via), ["control", "control"]);
	assert.deepEqual(next.requests.filter((r) => r.op === "submit").map((r) => r.text), ["held one", "held two"], "FIFO");
	assert.deepEqual(keys(), []);
});

test("pi host: a reload that misses its deadline refuses the held send with the restart step, and types nothing", async (t) => {
	const { send, keys } = await reloading(t, { deadlineIn: 1_500 });
	const started = Date.now();
	await assert.rejects(send("held late"), (e: any) => e.code === "control_reloading" && /restart this Pi Session/i.test(e.message) && !/\/reload/.test(e.message));
	assert.ok(Date.now() - started >= 1_000, "it held until the deadline");
	assert.deepEqual(keys(), []);
});

test("pi host: held sends are bounded; the ninth is refused at once, and none become keys", async (t) => {
	const { f, send, keys } = await reloading(t, { deadlineIn: 10_000 });
	const held = Array.from({ length: 8 }, (_, i) => send(`held ${i}`));
	await new Promise((resolve) => setTimeout(resolve, 300));
	await assert.rejects(send("held overflow"), (e: any) => e.code === "control_reloading");
	const next = await control(f, f.sessionA, { nonce: "n-reloaded" });
	t.after(() => next.close());
	assert.equal((await Promise.all(held)).length, 8);
	assert.deepEqual(next.requests.filter((r) => r.op === "submit").map((r) => r.text), Array.from({ length: 8 }, (_, i) => `held ${i}`));
	assert.deepEqual(keys(), []);
});

test("pi host: a reloading descriptor with a dead pid never holds: the Session quit, so today's route applies", async (t) => {
	const { send } = await reloading(t, { deadlineIn: 10_000, pid: spawnSync(process.execPath, ["-e", ""]).pid });
	const started = Date.now();
	const sent: any = await send("held stale");
	assert.equal(sent.via, "keys");
	assert.ok(Date.now() - started < 1_000, `it waited ${Date.now() - started} ms`);
});

test("pi host: a reload that never reopens refuses at once after its deadline, with no keys, until the restart ends the pid", async (t) => {
	// The owner removed pi-hc-control from settings and reloaded: the descriptor stays "reloading" and nothing replaces it.
	const pi = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	t.after(() => pi.kill("SIGKILL"));
	const { send, keys } = await reloading(t, { deadlineIn: -1, pid: pi.pid });
	for (const content of ["held after", "held again"]) {
		const started = Date.now();
		await assert.rejects(send(content), (e: any) => e.code === "control_reloading" && /restart this Pi Session/i.test(e.message));
		assert.ok(Date.now() - started < 1_000, `it waited ${Date.now() - started} ms`);
	}
	assert.deepEqual(keys(), []);
	// The restart step ends that process; the stale descriptor then holds nothing.
	pi.kill("SIGKILL");
	await new Promise((resolve) => pi.once("exit", resolve));
	assert.equal(((await send("held restarted")) as any).via, "keys");
});

test("pi host: a command-list read held across a reload outlasts the old 10 s hub wait and gets the new list", async (t) => {
	const { f, browser } = await reloading(t, { deadlineIn: 10_000 });
	const listed = browser.req("devbox", "thread.commands", { threadId: "pi:sess-a" });
	await new Promise((resolve) => setTimeout(resolve, 9_500));
	const next = await control(f, f.sessionA, { nonce: "n-reloaded", commands: true });
	t.after(() => next.close());
	assert.deepEqual(((await listed) as any).models, [{ ref: "p/m2" }]);
});
