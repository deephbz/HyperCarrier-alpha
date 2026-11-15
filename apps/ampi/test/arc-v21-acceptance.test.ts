import "./bound.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { arcFixture, arcLinkFixture, RecordingModel, until, writeDelayShim } from "./arc-v21-fixture.ts";
import { tempHome } from "./helpers.ts";
import { maintainHost } from "../src/arc/service/client.ts";

test("Arc fixture: both isolated hubs read both Hosts through delayed real agents", async (t) => {
	const f = await arcFixture(t);
	assert.notEqual(f.hubs[0].stateDir, f.hubs[1].stateDir);
	assert.notEqual(f.hosts[0].agentDir, f.hosts[1].agentDir);
	for (const { browser } of f.hubs) {
		await browser.when(() => browser.hosts.length === 2 && browser.hosts.every(h => h.status === "connected"));
		for (const host of ["host-1", "host-2"]) {
			const sid = browser.sub(host, { kind: "threads" });
			await browser.until<any>(sid, v => Boolean(v.threads["pi:sess-a"]));
		}
	}
	assert.ok(f.models.every(model => model.calls.length === 0), "Reading does not invoke the model");
	await f.hubs[0].close();
	assert.equal(f.hubs[1].browser.hosts.length, 2, "Closing one hub leaves the other connected");
});

test("Arc fixture: delay shim delays both directions without changing bytes", async (t) => {
	const dir = tempHome();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const child = spawn(writeDelayShim(dir), ["-e", "process.stdin.pipe(process.stdout)"], { stdio: "pipe" });
	t.after(() => child.kill());
	let output = "";
	child.stdout.on("data", chunk => output += chunk);
	const started = performance.now();
	child.stdin.write("synthetic request\n");
	await until(() => output.includes("\n"), "delayed echo");
	assert.equal(output, "synthetic request\n");
	assert.ok(performance.now() - started >= 300, "The round trip includes 300 ms injected delay");
});

test("Arc fixture: model acceptance persists before release and counts separate calls", async (t) => {
	const dir = tempHome();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const model = new RecordingModel(join(dir, "model"));
	model.block();
	const invoke = (input: string) => {
		const child = spawn(model.command[0], model.command.slice(1), { stdio: "pipe" });
		t.after(() => child.kill());
		let output = "";
		child.stdout.on("data", chunk => output += chunk);
		const done = new Promise<number | null>(resolve => child.once("close", resolve));
		child.stdin.end(input);
		return { done, output: () => output };
	};
	const first = invoke("first synthetic prompt");
	await until(() => model.calls.length === 1, "first accepted call");
	assert.equal(first.output(), "", "Accepted call remains blocked");
	assert.equal(JSON.parse(readFileSync(model.log, "utf8").trim()).input, "first synthetic prompt");
	model.release("recorded answer");
	assert.equal(await first.done, 0);
	assert.equal(first.output(), "recorded answer");
	const second = invoke("second synthetic prompt");
	assert.equal(await second.done, 0);
	assert.deepEqual(model.calls.map(call => call.input), ["first synthetic prompt", "second synthetic prompt"]);
	assert.ok(existsSync(model.log), "Acceptance evidence stays on disk");
});

// These checks observe the panel projection over real Hub WebSockets and delayed Host links.
// Typography and semantic model quality remain outside this link acceptance scope.
const opts = { timeout: 35_000 };
type Link = Awaited<ReturnType<typeof arcLinkFixture>>;
const value = (h: Link["hubs"][number]) => h.browser.values.get(h.sid) as any;
const pause = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));
const equalReceipts = async (f: Link) => {
	const first = await f.complete(f.hubs[0]);
	const second = await f.hubs[1].browser.until<any>(f.hubs[1].sid, v => v.receipt?.builtAt === first.receipt.builtAt && v.status.state === "idle", 20_000);
	assert.deepEqual(first.receipt, second.receipt); assert.equal(f.model.calls.length, 1);
	return first.receipt;
};

test("Arc link acceptance: two hubs join one paid Build and share equal receipts", opts, async t => {
	const f = await arcLinkFixture(t); await f.ready(); f.model.block();
	const result = await Promise.all(f.hubs.map((hub, n) => f.command(hub, `shared-${n}`)));
	assert.ok(result.every(r => r.outcome === "accepted")); assert.equal(result[0].buildId, result[1].buildId);
	await until(() => f.model.calls.length === 1, "one paid shared call");
	for (const hub of f.hubs) await hub.browser.until<any>(hub.sid, v => v.status.state === "building");
	f.model.release(); const receipt = await equalReceipts(f);
	assert.equal(receipt.builds.at(-1).calls, 1); assert.equal(receipt.builds.at(-1).usage.cost, .01);
});

test("Arc link acceptance: lost Build acknowledgement survives hub restart without repayment", opts, async t => {
	const f = await arcLinkFixture(t); await f.ready(); const original = f.hubs[0];
	await import("node:fs").then(fs => fs.writeFileSync(original.ackHold, "hold"));
	void f.command(original, "restart-owner").catch(() => undefined);
	await until(() => f.model.calls.length === 1 && f.wireRows(original.wire).some(r => r.frame.t === "arc.ack"), "Host accepted before restart");
	await original.close(); rmSync(original.ackHold);
	const restarted = await f.launchHub("hub-a");
	await restarted.browser.until<any>(restarted.sid, v => v.request?.requestId === "restart-owner" && v.request.outcome === "accepted" && v.receipt && v.status.state === "idle", 20_000);
	const commands = f.wireRows(original.wire).filter(r => r.frame.t === "arc.request" && r.frame.requestId === "restart-owner");
	assert.ok(commands.length >= 2); assert.deepEqual(commands[0].frame, commands.at(-1).frame); assert.equal(f.model.calls.length, 1);
	assert.deepEqual((await f.complete(f.hubs[1])).receipt, value(restarted).receipt);
});

test("Arc link acceptance: a Build survives a link cut and replays its exact request", opts, async t => {
	const f = await arcLinkFixture(t); await f.ready(); const hub = f.hubs[0]; f.model.block();
	const { writeFileSync } = await import("node:fs"); writeFileSync(hub.ackHold, "hold");
	void f.command(hub, "link-owner").catch(() => undefined);
	await until(() => f.model.calls.length === 1, "accepted call before link cut");
	writeFileSync(hub.cut, "cut");
	await hub.browser.when(() => hub.browser.hosts.some(h => h.id === "host-1" && h.status !== "connected"), 10_000);
	rmSync(hub.ackHold); rmSync(hub.cut); f.model.release();
	await hub.browser.until<any>(hub.sid, v => v.request?.outcome === "accepted" && v.receipt && !v.statusStale, 20_000);
	const sent = f.wireRows(hub.wire).filter(r => r.frame.t === "arc.request" && r.frame.requestId === "link-owner");
	assert.ok(sent.length >= 2); assert.deepEqual(sent[0].frame, sent.at(-1).frame);
	await equalReceipts(f);
});

test("Arc link acceptance: Host finishes with no hubs and both reconnect to the same Arc", opts, async t => {
	const f = await arcLinkFixture(t); await f.ready(); f.model.block();
	assert.equal((await f.command(f.hubs[0], "no-hubs")).outcome, "accepted");
	await until(() => f.model.calls.length === 1, "accepted before all hubs close");
	await Promise.all(f.hubs.map(h => h.close())); f.model.release();
	await until(async () => (await f.query({ op: "snapshot" })).receipts.length === 1, "Host commits without hubs");
	const a = await f.launchHub("hub-a"), b = await f.launchHub("hub-b");
	assert.deepEqual((await f.complete(a)).receipt, (await f.complete(b)).receipt); assert.equal(f.model.calls.length, 1);
});

test("Arc link acceptance: dismissal from one hub reaches both without a paid call", opts, async t => {
	const f = await arcLinkFixture(t); f.model.configure({ drop: true }); await f.ready();
	await f.command(f.hubs[0], "dismiss-build"); const receipt = await equalReceipts(f);
	assert.ok(receipt.drops.length > 0); const drop = receipt.drops[0];
	assert.equal((await f.hubs[1].browser.req("host-1", "view.arc.dismiss", { threadId: "pi:sess-a", dropId: drop.id, toPosition: drop.toPosition })).outcome, "dismissed");
	for (const hub of f.hubs) await hub.browser.until<any>(hub.sid, v => v.receipt && v.receipt.drops.length === 0);
	assert.deepEqual(value(f.hubs[0]).receipt, value(f.hubs[1]).receipt); assert.equal(f.model.calls.length, 1);
});

test("Arc link acceptance: a late unknown acknowledgement cannot revive an accepted request line", opts, async t => {
	const f = await arcLinkFixture(t); await f.ready(); const hub = f.hubs[0];
	assert.equal((await f.command(hub, "terminal-owner")).outcome, "accepted"); await equalReceipts(f);
	f.inject(hub, { t: "arc.ack", requestId: "terminal-owner", result: { outcome: "unknown" } });
	await until(() => !existsSync(hub.inject), "stale unknown ack delivered"); await pause();
	assert.equal(value(hub).request.outcome, "accepted"); assert.equal(f.model.calls.length, 1);
});

test("Arc link acceptance: an old acknowledgement cannot replace the latest owner request", opts, async t => {
	const f = await arcLinkFixture(t); await f.ready(); const hub = f.hubs[0];
	await f.command(hub, "previous-owner"); await equalReceipts(f);
	const next = await f.command(hub, "latest-owner"); assert.equal(next.outcome, "accepted");
	f.inject(hub, { t: "arc.ack", requestId: "previous-owner", result: { outcome: "unknown" } });
	await until(() => !existsSync(hub.inject), "old owner ack delivered"); await pause();
	assert.equal(value(hub).request.requestId, "latest-owner"); assert.equal(value(hub).request.outcome, "accepted");
});

test("Arc link acceptance: stale receipt revisions and status generations cannot regress either panel", opts, async t => {
	const f = await arcLinkFixture(t); await f.ready(); await f.command(f.hubs[0], "monotone-owner"); const receipt = await equalReceipts(f);
	for (const hub of f.hubs) {
		const rows = f.wireRows(hub.wire), head = rows.findLast(r => r.frame.t === "arc.receipt").frame;
		f.inject(hub, { ...head, revision: head.revision - 1, receipt: { ...head.receipt, goal: { text: "Stale synthetic goal", cites: [] } } },
			{ t: "arc.status", generation: "obsolete-synthetic-generation", seq: 999999, service: {}, statuses: [{sessionRef:"pi:sess-a",state:"failed"}], scheduled: [] });
		await until(() => !existsSync(hub.inject), "stale frames delivered");
	}
	await pause(); for (const hub of f.hubs) { assert.deepEqual(value(hub).receipt, receipt); assert.equal(value(hub).status.state, "idle"); }
	assert.equal(f.model.calls.length, 1);
});

test("Arc link acceptance: panel reads use the hub replica and make no construction requests", opts, async t => {
	const f = await arcLinkFixture(t); await f.ready(); await f.command(f.hubs[0], "read-owner"); await equalReceipts(f);
	const before = f.hubs.map(h => f.wireRows(h.wire).filter(r => r.frame.t === "arc.request").length);
	for (const hub of f.hubs) for (let n = 0; n < 4; n++) {
		const sid = hub.browser.sub("host-1", { kind: "view", view: "arc", threadId: "pi:sess-a" });
		await hub.browser.until<any>(sid, v => Boolean(v.receipt));
	}
	assert.deepEqual(f.hubs.map(h => f.wireRows(h.wire).filter(r => r.frame.t === "arc.request").length), before);
	assert.equal(f.model.calls.length, 1); assert.ok(f.hubs.every(h => h.browser.gaps.length === 0));
});

for (const [label, config, state, field] of [
	["invalid settings", { invalidSettings: true }, "invalid-settings", "key"],
	["no sign-in", { auth: "not_ready" as const }, "no-sign-in", "path"],
	["missing Pi", { missingPi: true }, "cannot-start", "prerequisite"],
] as const) test(`Arc link acceptance: ${label} facts reach both panel projections without a paid call`, opts, async t => {
	const f = await arcLinkFixture(t, config);
	await f.query({ op: "status" }); // Explicit status refreshes sign-in; idle relay polling does not.
	for (const hub of f.hubs) {
		const v = await hub.browser.until<any>(hub.sid, v => v.services?.[0]?.state === state, 20_000);
		assert.ok(v.services[0][field]); assert.equal(v.services[0].host, "host-1");
	}
	assert.equal(f.model.calls.length, 0);
});

test("Arc link acceptance S1: lost acceptance survives service replacement and both hub restarts", { timeout: 45_000 }, async t => {
	const f = await arcLinkFixture(t); await f.ready(); f.model.block();
	const [a, b] = f.hubs;
	const { writeFileSync } = await import("node:fs"); writeFileSync(a.ackHold, "hold");
	void f.command(a, "replace-owner").catch(() => undefined);
	await until(() => f.model.calls.length === 1 && f.wireRows(a.wire).some(r => r.frame.t === "arc.ack" && r.frame.requestId === "replace-owner"), "accepted owner command before replacement");
	const accepted = f.wireRows(a.wire).find(r => r.frame.t === "arc.ack" && r.frame.requestId === "replace-owner").frame.result;
	assert.equal(accepted.outcome, "accepted");
	const joined = await f.command(b, "replace-joiner");
	assert.equal(joined.outcome, "accepted"); assert.equal(joined.buildId, accepted.buildId);
	const original = await f.query({ op: "status", refreshAuth: false });
	assert.deepEqual(Object.keys(original.stamp).sort(), ["id", "line", "order"]); assert.equal(original.stamp.order, 100);
	const replacement = maintainHost({ id: "host-1", label: "host-1", kind: "pi-local", agentConfig: { agentDir: f.host.agentDir },
		env: { HOME: f.host.dir, AMPI_HOME: join(f.host.dir, "ampi"), PI_BIN: f.model.command[1], PI_CODING_AGENT_DIR: f.host.agentDir } },
		{ op: "ensure", timeoutMs: 30_000 }, f.bodies.newer);
	await until(async () => (await f.query({ op: "status", refreshAuth: false })).state === "updating", "new service offer drains the held Build");
	await a.close(); await b.close(); rmSync(a.ackHold);
	const drainingA = await f.launchHub("hub-a"), drainingB = await f.launchHub("hub-b");
	for (const [hub, requestId] of [[drainingA, "replace-owner"], [drainingB, "replace-joiner"]] as const) {
		const replay = await hub.browser.until<any>(hub.sid, v => v.request?.requestId === requestId && v.request.outcome === "accepted", 15_000);
		assert.equal(replay.request.buildId, accepted.buildId);
	}
	assert.equal(f.model.calls.length, 1, "Drain replay cannot make a second paid call");
	await drainingA.close(); await drainingB.close(); f.model.release();
	const replaced = await replacement;
	assert.equal(replaced.state, "running"); assert.equal(replaced.stamp.order, 200); assert.notEqual(replaced.pid, original.pid);
	const finalA = await f.launchHub("hub-a", f.bodies.newer), finalB = await f.launchHub("hub-b", f.bodies.newer);
	const [left, right] = await Promise.all([f.complete(finalA), f.complete(finalB)]);
	assert.deepEqual(left.receipt, right.receipt); assert.equal(left.request.buildId, accepted.buildId); assert.equal(right.request.buildId, accepted.buildId);
	const press = await f.command(finalA, "replace-owner");
	assert.equal(press.outcome, "accepted"); assert.equal(press.buildId, accepted.buildId);
	const sent = f.wireRows(a.wire).filter(r => r.frame.t === "arc.request" && r.frame.requestId === "replace-owner");
	assert.ok(sent.length >= 2); assert.deepEqual(sent[0].frame, sent.at(-1).frame);
	const authority = await f.query({ op: "request", sessionRef: "pi:sess-a", requestId: "replace-owner", kind: "manual", requester: sent[0].frame.requester });
	assert.equal(authority.outcome, "accepted"); assert.equal(authority.buildId, accepted.buildId);
	assert.equal(f.model.calls.length, 1); assert.equal(left.receipt.builds.at(-1).calls, 1);
});

test("Arc link acceptance: an older hub refuses with update text and makes no paid call", opts, async t => {
	const f = await arcLinkFixture(t); await f.ready();
	await Promise.all(f.hubs.map(h => h.close()));
	const newer = await f.launchHub("newer", f.bodies.newer);
	await newer.browser.until<any>(newer.sid, v => v.canDismiss === true, 20_000);
	const older = await f.launchHub("older", f.bodies.older);
	const refused = await older.browser.until<any>(older.sid, v => v.services?.[0]?.text === "This AmPi is older than host-1. Update it.", 20_000);
	assert.equal(refused.canDismiss, false);
	const press = await f.command(older, "older-press");
	assert.equal(press.outcome, "refused"); assert.equal(press.code, "service");
	assert.equal(press.detail, "This AmPi is older than host-1. Update it.");
	assert.equal(f.model.calls.length, 0);
});

test("Arc link acceptance: a newer hub replaces the service and preserves committed Arcs", opts, async t => {
	const f = await arcLinkFixture(t); await f.ready(); await f.command(f.hubs[0], "before-upgrade"); const receipt = await equalReceipts(f);
	const before = await f.query({ op: "status", refreshAuth: false }); await Promise.all(f.hubs.map(h => h.close()));
	const a = await f.launchHub("new-a", f.bodies.newer), b = await f.launchHub("new-b", f.bodies.newer);
	for (const hub of [a, b]) {
		const v = await f.complete(hub); assert.deepEqual(v.receipt, receipt); assert.equal(v.canDismiss, true);
	}
	const after = await f.query({ op: "status", refreshAuth: false });
	assert.notEqual(after.pid, before.pid); assert.notEqual(after.serviceVersion, before.serviceVersion); assert.equal(after.buildOrder, 200);
	assert.equal(f.model.calls.length, 1);
});
