import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
// Keep a real timer for subprocess and WebSocket I/O while one case advances only hub time.
const realTimeout = globalThis.setTimeout;
const ioPause = (ms: number) => new Promise<void>(resolve => realTimeout(resolve, ms));
async function ioUntil(predicate: () => boolean, what: string, timeoutMs = 5000) {
	for (let i = 0; i < Math.ceil(timeoutMs / 25); i++) { if (predicate()) return; await ioPause(25); }
	assert.fail(`Timed out: ${what}`);
}
import { ask, BACKGROUND_CONCURRENCY } from "../src/pi/ask.ts";
import { answer, DEFAULT_MODEL, done, evidence, initial, setup, sleep, waitFor } from "./arc-v2-fixture.ts";

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
	assert.equal(failed.status.state, "queued"); assert.equal(failed.status.error?.code, "model");
	assert.match(failed.status.error!.message, /Synthetic provider unavailable/);
	assert.deepEqual(failed.receipt.chapters, before.chapters);
	assert.equal(h.starts().length, 2, "one failed model call, no immediate retry");
	assert.ok(failed.status.nextAt, "the panel exposes the recovery time");
	const next = Date.parse(failed.status.nextAt!);
	assert.ok(next >= started + 60_000 && next <= Date.now() + 91_000, "first backoff is one minute plus at most thirty seconds jitter");
	await sleep(1500); assert.equal(h.starts().length, 2);
	// Turning automatic Builds off cancels the retry, so no retry time stays on screen; the failure stays.
	h.setSettings({ auto: false });
	await waitFor(() => h.value().status.state === "failed", "retry cancelled");
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

// Contract: arc.md / Triggers: Sessions build independently; only ask.ts admission limits model calls.
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

// Contract: arc.md / Triggers / five-minute automatic cadence and pending flag.
// Virtual hub timers avoid a five-minute wall wait; model processes and WS I/O still run normally.
// Detect per-event automatic Builds inside the cadence and lost pending work at its end.
test("Arc v2: cadence coalesces pending triggers until five minutes after automatic start", async t => {
	const h = await setup(t, { entries: initial.slice(0, 2) });
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	t.after(() => t.mock.timers.reset());
	h.setSettings({ auto: true });
	h.append(evidence("u2"), evidence("a2", "assistant"));
	await ioUntil(() => h.value().stale === 4 && h.value().status.state === "queued", "four Rarebits ingested and debounce queued", 30_000);
	t.mock.timers.tick(20_001);
	await ioUntil(() => h.starts().length === 1, "first automatic call");
	await ioUntil(() => Boolean(h.value().receipt), "first receipt");
	const firstStart = Date.parse(h.value().receipt.builds[0].startedAt);
	h.append(evidence("u3"), evidence("a3", "assistant"), evidence("u4"));
	await ioUntil(() => h.value().stale === 3 && h.value().status.state === "queued", "three pending Rarebits ingested and cadence queued", 30_000);
	t.mock.timers.tick(20_001); await ioPause(200);
	assert.equal(h.starts().length, 1, "debounce expiry does not bypass cadence");
	t.mock.timers.tick(279_998); await ioPause(200);
	assert.equal(h.starts().length, 1, "one millisecond before cadence");
	t.mock.timers.tick(2);
	await ioUntil(() => h.starts().length === 2, "pending automatic call after cadence");
	await ioUntil(() => h.value().receipt?.asOf === "u4", "pending receipt");
	const latest = h.value().receipt.builds.find((b: any) => b.startedAt !== new Date(firstStart).toISOString());
	assert.ok(Date.parse(latest.startedAt) - firstStart >= 300_000);
	t.mock.timers.reset();
});

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

// Contract: arc.md / Triggers: shared ask admission; a Build waits for a slot instead of failing busy.
// Detect an Arc Build that fails, or takes the interactive slot, while other calls hold the hub's capacity.
test("Arc v2: a manual Build waits for a background slot held by non-Arc calls instead of failing busy", { timeout: 45_000 }, async t => {
	const h = await setup(t, { entries: initial });
	const helperGate = h.gate("helper-release"), arcGate = h.gate("arc-release");
	h.plan([...Array.from({ length: BACKGROUND_CONCURRENCY }, () => ({ answer: answer(), gate: helperGate })), { answer: answer(), gate: arcGate }]);
	const helpers = Array.from({ length: BACKGROUND_CONCURRENCY }, () => ask({ system: "Synthetic helper context.", prompt: "Synthetic helper question.", model: DEFAULT_MODEL, resolved: true, admission: "background" }, h.askCommand));
	t.after(async () => { h.release(helperGate); h.release(arcGate); await Promise.allSettled(helpers); });
	await waitFor(() => h.starts().length === BACKGROUND_CONCURRENCY, "non-Arc calls hold every background slot", 20_000);
	await h.browser.req("devbox", "view.arc.build", { threadId: "pi:sess-a" });
	await sleep(1000);
	assert.equal(h.starts().length, BACKGROUND_CONCURRENCY, "the Build leaves the interactive slot free");
	assert.notEqual(h.value().status.state, "failed", "busy is admission wait, not a failed Build");
	assert.equal(h.value().status.progress, "Waiting for a model slot", "the panel shows the admission wait, not a running window");
	h.release(helperGate); await Promise.all(helpers);
	await waitFor(() => h.starts().length === BACKGROUND_CONCURRENCY + 1, "Build admitted when a slot frees", 4000);
	await waitFor(() => /^Building messages/.test(h.value().status.progress ?? ""), "progress returns to the window after admission");
	h.release(arcGate);
	done(await h.browser.until<any>(h.sid, v => v.status.state === "idle" && Boolean(v.receipt)));
});
