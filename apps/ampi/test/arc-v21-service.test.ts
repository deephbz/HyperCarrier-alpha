import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { maintainHost, serviceBundle } from "../src/arc/service/client.ts";
import { controlRequest, type ControlCommand } from "../src/arc/service/runtime.ts";
import type { ManageOperation } from "../src/arc/service/entry.ts";
import { RecordingModel, until } from "./arc-v21-fixture.ts";
import { tempHome } from "./helpers.ts";
import { serviceText } from "../src/arc/service/status.ts";
import { automaticSchedule } from "../src/arc/service/schedule.ts";
import { createBuilder, fingerprint, type BuilderState, type SourceSnapshot } from "../src/arc/core/index.ts";

async function serviceFixture(t: TestContext, evidenceSize = 0) {
	const root = tempHome(), agent = join(root, "agent"), sessions = join(agent, "sessions");
	mkdirSync(sessions, { recursive: true });
	const sessionFile = join(sessions, "synthetic.jsonl");
	const message = (n: number) => ({ type: "message", id: `u${n}`, parentId: n ? `u${n - 1}` : null,
		timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: `Synthetic request ${n}.` + "x".repeat(evidenceSize) } });
	writeFileSync(sessionFile, [ { type: "session", version: 3, id: "synthetic", timestamp: "2026-01-01T00:00:00Z", cwd: "/synthetic/work" },
		...Array.from({ length: 6 }, (_, n) => message(n)) ].map(row => JSON.stringify(row)).join("\n") + "\n");
	const settings = (auto = false) => writeFileSync(join(agent, "settings.json"), JSON.stringify({ ampi_arc: { model: "synthetic/model", auto, concurrency: 1, retries: 0 } }));
	settings();
	const model = new RecordingModel(join(root, "model"), "pi");
	const config = { id: "synthetic", label: "Synthetic", kind: "pi-local" as const, agentConfig: { agentDir: agent },
		env: { HOME: root, AMPI_HOME: join(root, "ampi"), PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: sessions, PI_BIN: model.command[1] } };
	const body = await serviceBundle(), store = join(agent, "ampi-arc"), pids = new Set<number>();
	const manage = async (op: ManageOperation["op"], extra: Partial<ManageOperation> = {}) => {
		const result = await maintainHost(config, { ...extra, op, timeoutMs: 10_000 }, body);
		if (result.pid) pids.add(result.pid);
		if (op === "stop") await until(async () => { try { await controlRequest(store, { op: "status", refreshAuth: false }, 100); return false; } catch { return true; } }, "service stop releases its socket");
		return result;
	};
	const query = (command: ControlCommand) => controlRequest(store, { stamp: JSON.parse(readFileSync(join(store, "control.json"), "utf8")).selected, ...command });
	const snapshot = () => query({ op: "snapshot" });
	const request = (id: string, kind: "manual" | "incremental" = "manual", options?: { nextAt?: string }) => query({ op: "request", sessionRef: "pi:synthetic", requestId: id, requester: "synthetic-client", kind, options });
	t.after(async () => {
		for (const call of model.calls) pids.add(call.pid);
		for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
		await until(async () => { try { await controlRequest(store, { op: "status" }, 100); return false; } catch { return true; } }, "service cleanup");
		// The service removes its socket on graceful stop. A forced crash cannot do that.
		const { serviceAddress } = await import("../src/arc/service/runtime.ts");
		rmSync(serviceAddress(store), { force: true });
		rmSync(root, { recursive: true, force: true });
	});
	let nextEntry = 6;
	return { root, model, manage, query, snapshot, request, settings, append: () => appendFileSync(sessionFile, JSON.stringify(message(nextEntry++)) + "\n") };
}

test("Arc service acceptance S1: concurrent starts and repeated commands cannot duplicate a paid call", { timeout: 30_000 }, async t => {
	const f = await serviceFixture(t);
	const starts = await Promise.all([f.manage("ensure"), f.manage("ensure"), f.manage("ensure")]);
	assert.ok(starts.every(result => ["running", "busy"].includes(result.state)), JSON.stringify(starts));
	const owners = starts.filter(result => result.state === "running");
	assert.ok(owners.length > 0, JSON.stringify(starts));
	assert.equal(new Set(owners.map(result => result.pid)).size, 1, "All running results name one process");
	const owner = owners[0].pid;
	assert.equal((await f.manage("ensure")).pid, owner);
	process.kill(owner, "SIGSTOP");
	try {
		const busy = await f.manage("ensure");
		assert.equal(busy.state, "busy");
		assert.equal(busy.kind, "busy");
		assert.equal(busy.detail, "Arc service holds its lock but does not answer");
		assert.equal(serviceText(busy), "synthetic: Arc service holds its lock but does not answer. Run ampi arc status --host synthetic before retrying.");
		assert.doesNotMatch(JSON.stringify(busy), /base64|data:text|at manage/);
	} finally { process.kill(owner, "SIGCONT"); }
	f.model.block();
	const first = await f.request("same-command");
	assert.equal(first.outcome, "accepted");
	await until(() => f.model.calls.length === 1, "provider acceptance");
	const repeated = await Promise.all([f.request("same-command"), f.request("same-command")]);
	assert.ok(repeated.every(r => r.buildId === first.buildId));
	assert.equal(f.model.calls.length, 1);
	f.model.release();
	await until(async () => (await f.snapshot()).receipts.length === 1, "one committed receipt");
	const receipt = (await f.snapshot()).receipts[0].receipt;
	assert.equal(receipt.builds[0].calls, 1);
	assert.equal(receipt.builds[0].usage.cost, 0.01);
	assert.equal(f.model.calls.length, 1);
});

test("Arc service acceptance S2: temporary stop releases ownership and ensure restarts without spending", { timeout: 30_000 }, async t => {
	const f = await serviceFixture(t);
	const first = await f.manage("ensure");
	assert.equal(first.running, true);
	const stopped = await f.manage("stop");
	assert.equal(serviceText(stopped), "synthetic: Arc service is stopped. A linked hub restarts it within seconds.");
	await until(async () => { try { await f.query({ op: "status", refreshAuth: false }); return false; } catch { return true; } }, "temporary stop releases the socket");
	const next = await f.manage("ensure");
	assert.equal(next.running, true); assert.notEqual(next.pid, first.pid);
	assert.equal((await f.manage("status")).pid, next.pid);
	assert.equal(f.model.calls.length, 0, "Maintenance never calls the paid model");
});

test("Arc service acceptance S3: restart resumes a durable delayed command exactly once", { timeout: 30_000 }, async t => {
	const f = await serviceFixture(t);
	const owner = await f.manage("ensure");
	const due = new Date(Date.now() + 4000).toISOString();
	const accepted = await f.request("durable-pending", "incremental", { nextAt: due });
	assert.equal(accepted.outcome, "accepted");
	assert.equal(f.model.calls.length, 0);
	process.kill(owner.pid, "SIGKILL");
	await until(async () => { try { await f.query({ op: "status" }); return false; } catch { return true; } }, "crashed service");
	await f.manage("ensure");
	await until(async () => (await f.snapshot()).receipts.length === 1, "recovered command receipt");
	assert.equal(f.model.calls.length, 1);
	const revision = (await f.snapshot()).receipts[0].revision;
	await f.manage("stop");
	await f.manage("ensure");
	const retried = await f.request("durable-pending", "incremental", { nextAt: due });
	assert.equal(retried.buildId, accepted.buildId);
	await delay(2200);
	assert.equal(f.model.calls.length, 1, "Restart and transport retry do not repay a completed command");
	assert.equal((await f.snapshot()).receipts[0].revision, revision);
});

test("Arc service acceptance S4: provider acceptance followed by a crash pauses automatic spending", { timeout: 30_000 }, async t => {
	const f = await serviceFixture(t);
	f.model.block();
	const owner = await f.manage("ensure");
	assert.equal((await f.request("before-crash")).outcome, "accepted");
	await until(() => f.model.calls.length === 1, "paid call acceptance before crash");
	process.kill(owner.pid, "SIGKILL");
	await until(async () => { try { await f.query({ op: "status" }); return false; } catch { return true; } }, "crashed service");
	f.settings(true);
	await f.manage("ensure");
	const recovered = await f.snapshot();
	assert.equal(recovered.statuses[0].state, "uncertain");
	assert.equal(recovered.statuses[0].pause, "uncertain-call");
	assert.equal((await f.request("automatic-after-crash", "incremental")).code, "paused");
	f.append();
	await delay(4300);
	assert.equal(f.model.calls.length, 1, "Automatic ticks and new owner evidence cannot replay an uncertain call");
	assert.equal((await f.snapshot()).receipts.length, 0, "A lost answer cannot publish a receipt");
});

test("Arc service acceptance S5: an append burst makes one paid Build and retains the five-minute deadline", { timeout: 50_000 }, async t => {
	const f = await serviceFixture(t);
	f.settings(true);
	await f.manage("ensure");
	await until(async () => (await f.snapshot()).scheduled.length === 1, "initial debounce");
	const firstDeadline = Date.parse((await f.snapshot()).scheduled[0].nextAt);
	await delay(2300);
	f.append(); f.append(); f.append();
	await until(async () => Date.parse((await f.snapshot()).scheduled[0]?.nextAt) > firstDeadline, "burst resets debounce");
	const deadline = Date.parse((await f.snapshot()).scheduled[0].nextAt);
	assert.equal(f.model.calls.length, 0);
	await delay(Math.max(0, deadline - Date.now() - 500));
	assert.equal(f.model.calls.length, 0, "No paid call before the debounce deadline");
	await until(async () => (await f.snapshot()).receipts.length === 1, "debounced receipt", 10_000);
	assert.equal(f.model.calls.length, 1);
	assert.ok(f.model.calls[0].acceptedAt >= deadline);
	f.append();
	await until(async () => (await f.snapshot()).scheduled.length === 1, "cadence wait");
	const cadence = (await f.snapshot()).scheduled[0].nextAt;
	assert.ok(Date.parse(cadence) >= f.model.calls[0].acceptedAt + 299_000, "The next automatic Build waits five minutes after prior admission");
	await f.manage("stop"); await f.manage("ensure");
	assert.equal((await f.snapshot()).scheduled[0].nextAt, cadence, "Restart preserves the cadence deadline");
	await delay(2200);
	assert.equal(f.model.calls.length, 1);
});

test("Arc service acceptance S5 clock boundary: cadence blocks one millisecond early and dispatches when due", async () => {
	let now = 1_000_000, calls = 0, state: BuilderState | undefined;
	const source: SourceSnapshot = { session: "synthetic", sourceVersion: "v1", selector: "synthetic", fingerprint: "",
		items: Array.from({ length: 6 }, (_, n) => ({ id: `e${n}`, owner: true, kind: "user" as const, text: `Synthetic evidence ${n}.`, t: null })), entries: [] };
	source.fingerprint = fingerprint(source.items);
	const builder = createBuilder({ now: () => new Date(now).toISOString(), source: { snapshot: async () => structuredClone(source), check: async () => ({ kind: "same-prefix" }) },
		store: { load: () => state, save: value => { state = structuredClone(value); } }, settings: () => ({ model: "synthetic/model", retries: 0 }),
		admission: { acquire: async () => ({ kind: "permit", permit: { id: "synthetic" } }), release: async () => {} },
		model: { reconcile: async () => "gone", call: async input => {
			calls++;
			const data = JSON.parse(input.prompt.split("\nAnswer rejected:")[0]);
			const last = data.rarebits.at(-1), claim = { text: "Review the synthetic work.", cites: [{ id: last.id, quote: last.text }] };
			return { kind: "answer", answer: { model: "synthetic/model", text: JSON.stringify({ goal: claim, now: claim, points: [], chapters: [{ firstId: data.rarebits[0].id, label: "Synthetic work", closed: true, summary: { scope: claim, bullets: [] } }] }) } };
		} } });
	const scheduler = automaticSchedule({ builder, state: {}, save: () => {}, now: () => now });
	scheduler.observe(source, true);
	now += 19_999; await scheduler.tick(true); await builder.run(); assert.equal(calls, 0);
	now++; await scheduler.tick(true); await builder.run(); assert.equal(calls, 1);
	const firstAdmission = now;
	source.items.push({ id: "e6", owner: true, kind: "user", text: "New synthetic evidence.", t: null });
	source.sourceVersion = "v2"; source.fingerprint = fingerprint(source.items);
	scheduler.observe(source, true);
	now = firstAdmission + 299_999; await scheduler.tick(true); await builder.run(); assert.equal(calls, 1);
	now++; await scheduler.tick(true); await builder.run(); assert.equal(calls, 2);
});

test("Arc service acceptance S6: failure in a later paid window retains a readable partial Arc", { timeout: 30_000 }, async t => {
	const f = await serviceFixture(t, 46_000);
	f.model.configure({ failAfter: 1 });
	await f.manage("ensure");
	await f.request("partial-build");
	await until(async () => (await f.snapshot()).statuses[0]?.state === "failed", "later window failure");
	const before = await f.snapshot(), partial = before.receipts[0].receipt;
	assert.ok(partial.asOfCount > 0 && partial.asOfCount < 6, "Accepted windows remain visible without claiming complete coverage");
	assert.ok(partial.goal.text.length > 0);
	assert.equal(f.model.calls.length, 2);
	assert.equal(partial.builds.at(-1).state, "failed");
	assert.equal(partial.builds.at(-1).calls, 2);
	assert.equal(partial.builds.at(-1).usage.cost, 0.03);
	await f.manage("stop"); await f.manage("ensure");
	assert.deepEqual((await f.snapshot()).receipts, before.receipts, "Restart keeps the partial receipt and failure accounting");
	assert.equal(f.model.calls.length, 2);
});

test("Arc service acceptance S7: absent provider cost remains null after receipt persistence and restart", { timeout: 30_000 }, async t => {
	const f = await serviceFixture(t);
	f.model.configure({ cost: null });
	await f.manage("ensure"); await f.request("unknown-cost");
	await until(async () => (await f.snapshot()).receipts.length === 1, "unknown-cost receipt");
	const receipt = (await f.snapshot()).receipts[0].receipt;
	assert.equal(receipt.builds[0].usage.input, 10);
	assert.equal(receipt.builds[0].usage.cost, null);
	assert.equal(receipt.builds[0].callUsage[0].usage.cost, null);
	await f.manage("stop"); await f.manage("ensure");
	assert.equal((await f.snapshot()).receipts[0].receipt.builds[0].usage.cost, null);
	assert.equal(f.model.calls.length, 1);
});
