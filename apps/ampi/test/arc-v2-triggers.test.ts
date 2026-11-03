import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { answer, done, evidence, initial, setup, sleep, waitFor } from "./arc-v2-fixture.ts";

// Contract: arc.md / Triggers / Debounce, ARC_FLOOR, auto defaults.
// Detect premature calls, missing stop/owner triggers, and one Build per event instead of trailing debounce.
test("Arc v2: automatic Build needs four Rarebits and waits twenty seconds after the latest trigger", { timeout: 45_000 }, async t => {
	const h = await setup(t, { entries: initial.slice(0, 2), omitSettings: true });
	await sleep(1000); assert.equal(h.starts().length, 0, "below the floor");
	h.append(evidence("u2"), evidence("a2", "assistant"));
	await sleep(12_000); assert.equal(h.starts().length, 0, "stop is debounced");
	const ownerAt = Date.now(); h.append(evidence("u3"));
	await sleep(12_000); assert.equal(h.starts().length, 0, "owner reply resets debounce");
	await waitFor(() => h.starts().length > 0, "one automatic Build after debounce", 12_000);
	assert.ok(h.starts()[0]!.at - ownerAt >= 19_500, "no earlier than twenty seconds, allowing poll jitter");
	const v = await h.browser.until<any>(h.sid, v => v.status.state === "idle" && v.receipt?.asOf === "u3");
	assert.equal(v.receipt.builds[0].trigger, "owner");
	assert.equal(h.starts().length, 1);
});

// Contract: arc.md / Validation and retry / model failure; Triggers / Backoff.
// Detect an immediate model retry and missing scheduled recovery; answer errors use a separate test.
test("Arc v2: model failure backs off without an immediate retry and keeps the last good receipt", async t => {
	// With automatic Builds on, the failure schedules a retry; its time and the error stay visible while it waits.
	const h = await setup(t, { arc: { auto: true }, steps: [{ answer: answer() }, { error: "Synthetic provider unavailable" }] });
	const before = done(await h.build());
	const started = Date.now();
	const failed = await h.build();
	assert.equal(failed.status.state, "failed"); assert.equal(failed.status.error?.code, "model");
	assert.match(failed.status.error!.message, /Synthetic provider unavailable/);
	assert.deepEqual(failed.receipt.chapters, before.chapters);
	assert.equal(h.starts().length, 2, "one failed model call, no immediate retry");
	assert.ok(failed.status.nextAt, "the panel exposes the recovery time");
	const next = Date.parse(failed.status.nextAt!);
	assert.ok(next >= started + 60_000 && next <= Date.now() + 91_000, "first backoff is one minute plus at most thirty seconds jitter");
	await sleep(1500); assert.equal(h.starts().length, 2);
	// Turning automatic Builds off cancels the retry, so no retry time stays on screen; the failure stays.
	h.setSettings({ auto: false });
	await waitFor(() => h.value().status.nextAt === undefined, "retry cancelled");
	assert.equal(h.value().status.nextAt, undefined); assert.equal(h.value().status.error?.code, "model");
});

// Contract: arc.md / Validation and retry: turning automatic Builds off cancels scheduled automatic work.
// Detect pending automatic work or a retry time that survives the setting while a Build runs.
test("Arc v2: turning automatic Builds off during a Build drops its pending automatic work", { timeout: 40_000 }, async t => {
	const h = await setup(t, { arc: { auto: true } });
	const gate = h.gate("auto-off-release");
	h.plan([{ error: "Synthetic provider unavailable", gate }, { answer: answer() }]);
	await h.browser.req("devbox", "view.arc.build", { threadId: "pi:sess-a" });
	await waitFor(() => h.starts().length === 1, "held manual Build");
	h.append(evidence("u3"), evidence("a3", "assistant"));
	await h.browser.until<any>(h.sid, v => v.status.state === "building");
	h.setSettings({ auto: false }); await sleep(1500);
	h.release(gate);
	const failed = await h.browser.until<any>(h.sid, v => v.status.state === "failed");
	assert.equal(failed.status.nextAt, undefined, "no retry time without a scheduled retry");
	await sleep(1500); assert.equal(h.starts().length, 1, "no automatic Build after the setting");
});

// Contract: arc.md / Triggers / pending flag and one Build per Session.
// Detect concurrent Builds of one Session and lost/coalesced triggers while a model call is running.
test("Arc v2: triggers during a manual Build coalesce into one pending automatic Build", { timeout: 40_000 }, async t => {
	const h = await setup(t, { arc: { auto: true } });
	const gate = h.gate("pending-release");
	h.plan([{ answer: answer(), gate }, { answer: answer() }]);
	const started = Date.now();
	await h.browser.req("devbox", "view.arc.build", { threadId: "pi:sess-a" });
	await waitFor(() => h.starts().length === 1, "held manual Build");
	h.append(evidence("u3"), evidence("a3", "assistant"), evidence("u4"));
	await h.browser.until<any>(h.sid, v => v.status.state === "building");
	await sleep(1000); assert.equal(h.starts().length, 1, "the pending flag cannot start a parallel Build");
	h.release(gate);
	await h.browser.until<any>(h.sid, v => v.receipt?.asOf === "u4", 28_000);
	assert.equal(h.starts().length, 2, "three triggers become one follow-up");
	assert.ok(h.starts()[1]!.at >= started);
	await sleep(1000); assert.equal(h.starts().length, 2, "no third Build for the coalesced events");
});

// Contract: arc.md / Triggers: Sessions build independently within Host admission.
// Detect an Arc-local slot count that makes one Session's Build wait for another's.
test("Arc v2: automatic Builds of different Sessions run in parallel", { timeout: 42_000 }, async t => {
	const h = await setup(t, { arc: { auto: true }, entries: initial.slice(0, 2) });
	const gate = h.gate("parallel-release");
	h.plan([{ answer: answer(), gate }]);
	h.writeSession("c", initial); h.writeSession("d", initial);
	h.append(evidence("u2"), evidence("a2", "assistant"));
	await waitFor(() => h.starts().length === 3, "three Sessions build at once", 28_000);
	h.release(gate);
	await h.browser.until<any>(h.sid, v => v.status.state === "idle" && Boolean(v.receipt));
	let active = 0, max = 0;
	for (const event of h.calls()) { active += event.event === "start" ? 1 : -1; max = Math.max(max, active); }
	assert.equal(max, 3);
});

// The service scheduler owns the clock. arc-service-adapters.test.ts verifies
// five-minute cadence and burst coalescing with its injected Host clock.

// Contract: arc.md / Triggers: a manual Build starts at once and joins a running Build of its own Session.
// Detect manual work that waits behind other Sessions, and duplicate Builds of one Session.
test("Arc v2: manual Builds start at once beside automatic Builds and join their own Session's Build", { timeout: 45_000 }, async t => {
	const h = await setup(t, { arc: { auto: true }, entries: initial.slice(0, 2) });
	const gate = h.gate("all-release"); h.plan([{ answer: answer(), gate }]);
	h.writeSession("c", initial); h.writeSession("d", initial); h.writeSession("e", initial.slice(0, 2));
	await waitFor(() => h.starts().length === 2, "two held automatic calls", 28_000);
	const manualAt = Date.now();
	await h.browser.req("devbox", "view.arc.build", { threadId: "pi:sess-a" });
	await h.browser.req("devbox", "view.arc.build", { threadId: "pi:e" });
	await waitFor(() => h.starts().length === 4, "both manual calls", 4000);
	assert.ok(h.starts()[3]!.at - manualAt < 4000, "manual Builds skip debounce and wait for no other Session");
	await h.browser.req("devbox", "view.arc.build", { threadId: "pi:c" });
	await sleep(1000); assert.equal(h.starts().length, 4, "a manual Build joins its Session's automatic Build");
	h.release(gate);
	await h.browser.until<any>(h.sid, v => v.status.state === "idle" && Boolean(v.receipt));
	assert.equal(h.starts().length, 4);
});

// Provisional Host-local admission: all Arc calls on this Host share its limit.
// A waiting Build remains durable and starts after the running call settles.
test("Arc service: a manual Build waits for the Host slot and resumes without a busy failure", { timeout: 20000 }, async t => {
 const h = await setup(t, { arc: { auto: false, concurrency: 1 } });
 const gate = h.gate("host-slot"); h.plan([{ answer: answer(), gate }]);
 h.writeSession("c", initial);
 await h.browser.req("devbox", "view.arc.build", { threadId: "pi:sess-a" });
 await waitFor(() => h.starts().length === 1, "first Host call");
 const sid = h.browser.sub("devbox", { kind: "view", view: "arc", threadId: "pi:c" });
 await h.browser.req("devbox", "view.arc.build", { threadId: "pi:c" });
 const waiting = await h.browser.until<any>(sid, v => v.status.state === "waiting");
 assert.equal(waiting.status.wait.running, 1); assert.equal(waiting.status.wait.limit, 1);
 assert.equal(waiting.status.waitCause, "capacity"); assert.equal(h.starts().length, 1);
 h.setSettings({ auto: false, concurrency: 1 }); h.release(gate);
 await h.browser.until<any>(sid, v => v.status.state === "idle" && Boolean(v.receipt));
 assert.equal(h.starts().length, 2, "a manual Build stays accepted when automatic Builds are off");
});
