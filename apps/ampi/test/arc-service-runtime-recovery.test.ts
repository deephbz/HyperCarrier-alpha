import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, symlinkSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, createReadStream, realpathSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection, createServer } from "node:net";
// @ts-expect-error Build script runs as native ESM.
import { buildArcService } from "../scripts/build-arc-service.mjs";
import { launchLocked, LOCK_BUSY } from "../src/arc/service/lock.ts";
import { serviceText, serviceStatus } from "../src/arc/service/status.ts";
import { storeIncarnation } from "../src/arc/service/store.ts";
import type { Socket } from "node:net";
import { controlRequest as rawControlRequest, serviceAddress } from "../src/arc/service/runtime.ts";
import type { ControlCommand } from "../src/arc/service/runtime.ts";
import { pathToFileURL } from "node:url";
import { maintainHost, maintenanceLaunch, parseArcArgs } from "../src/arc/service/client.ts";
import { piSource } from "../src/arc/service/source.ts";
import { fingerprint, storeAnswer } from "../src/arc/core/construct.ts";
import { blockingModel, controlRequest, fixture, managerClock, request, until } from "./arc-service-runtime-fixture.ts";

for (const frozen of [false, true]) test(`Arc recovery stops a verified socketless resident and the next Build succeeds (frozen=${frozen})`, { timeout: 20000, skip: process.platform !== "linux" }, async t => {
 const f = await fixture(t), model = blockingModel(f), poll = "options.pollMs ?? 2e3";
 assert.ok(f.body.includes(poll));
 // Keep the synthetic legacy owner from detecting its missing socket first.
 writeFileSync(f.bundle, f.body.replace(poll, "options.pollMs ?? 60000"));
 const resident = await f.manage("ensure"), lockPath = join(f.store, "service.lock");
 const { statSync } = await import("node:fs"), inode = statSync(lockPath).ino;
 if (frozen) process.kill(resident.pid, "SIGSTOP");
 rmSync(serviceAddress(f.store));
 const stopped = await f.manage("stop", { timeoutMs: 5000 });
 assert.equal(stopped.state, "stopped", "one explicit stop must recover the verified silent owner");
 assert.throws(() => process.kill(resident.pid, 0), { code: "ESRCH" });
 assert.equal(statSync(lockPath).ino, inode, "recovery must keep the lifetime-lock inode");
 assert.match(JSON.stringify(stopped), /SIGTERM/, "report the attempted signal");
 if (frozen) assert.match(JSON.stringify(stopped), /SIGKILL/, "report escalation against the same frozen owner");
 writeFileSync(model.release, "release");
 assert.equal((await f.manage("ensure")).running, true);
 assert.equal((await controlRequest(f.store, request("after-recovery"))).outcome, "accepted");
 await until(async () => (await controlRequest(f.store, { op: "snapshot" })).receipts.length === 1, "next Build did not commit after recovery");
 assert.equal(readFileSync(model.calls, "utf8"), "call\n");
 assert.equal((await f.manage("stop")).state, "stopped");
});

test("Arc forced recovery cancels another Session's queued Build and preserves a paid survivor", { timeout: 20000, skip: process.platform !== "linux" }, async t => {
 const f = await fixture(t), model = blockingModel(f); f.settings({ concurrency: 1 });
 const source = readFileSync(join(f.agent, "sessions", "session.jsonl"), "utf8");
 writeFileSync(join(f.agent, "sessions", "other.jsonl"), source.replace('"id":"fixture-session"', '"id":"other-session"'));
 const resident = await f.manage("ensure");
 const active = await controlRequest(f.store, request("paid-survivor"));
 await until(() => existsSync(model.pid), "model did not receive the paid prompt");
 const child = Number(readFileSync(model.pid, "utf8")); f.pids.add(child);
 const queued = await controlRequest(f.store, { ...request("queued-other"), sessionRef: "pi:other-session", options: { nextAt: new Date(Date.now() + 3600000).toISOString() } });
 assert.equal(queued.outcome, "accepted");
 process.kill(resident.pid, "SIGSTOP"); rmSync(serviceAddress(f.store));
 const recovered = await f.manage("stop", { timeoutMs: 5000 });
 assert.equal(recovered.state, "stopped"); assert.equal(recovered.kind, "forced-recovery");
 assert.match(serviceText(recovered), /may have charged|may have been charged/);
 process.kill(child, 0);
 const saved = JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8"));
 assert.equal(saved.jobs[queued.buildId].state, "cancelled");
 assert.equal(saved.jobs[active.buildId].record.usage.cost, null);
 assert.equal(saved.jobs[active.buildId].calls[0].execution.pid, child);
 assert.notEqual(saved.jobs[active.buildId].calls[0].executionState, "gone");
 const restarted = await f.manage("ensure"); assert.equal(restarted.runningBuilds, 1, "survivor still holds admission capacity");
 const snapshot = await controlRequest(f.store, { op: "snapshot" });
 assert.equal(snapshot.statuses.find((s: any) => s.sessionRef === "pi:other-session").record.state, "cancelled");
 assert.equal(readFileSync(model.calls, "utf8"), "call\n", "the queued Session must not start after restart");
 process.kill(child, 0);
});

for (const operation of ["ensure", "stop"]) test(`Arc pending forced recovery cancels queued work before ${operation} can enter an older selected runtime`, async t => {
 const f = await fixture(t); blockingModel(f);
 const resident = await f.manage("ensure");
 const queued = await controlRequest(f.store, { ...request("pending-recovery"), options: { nextAt: new Date(Date.now() + 3600000).toISOString() } });
 process.kill(resident.pid, "SIGKILL");
 await until(() => { try { process.kill(resident.pid, 0); return false; } catch { return true; } }, "synthetic resident did not end");
 const selected = JSON.parse(readFileSync(join(f.store, "control.json"), "utf8")).selected;
 const oldPath = join(f.store, "versions", selected.id, "service.mjs"), old = readFileSync(oldPath, "utf8");
 const seam = "async function startService(agentDir, host, ready) {";
 assert.ok(old.includes(seam));
 writeFileSync(oldPath, old.replace(seam, seam + `
  const fs = await import('node:fs');
  const saved = JSON.parse(fs.readFileSync(${JSON.stringify(join(f.store, "builder.json"))},'utf8'));
  if(saved.jobs[${JSON.stringify(queued.buildId)}].state !== 'cancelled') throw new Error('older runtime entered before queued cancellation');
 `));
 const generation = randomUUID();
 writeFileSync(join(f.store, "stop.json"), JSON.stringify({ generation, recovery: { generation, state: "pending" } }));
 const reply = await f.manage(operation);
 assert.ok(operation === "ensure" ? reply.running === true : reply.state === "stopped", JSON.stringify(reply));
 const saved = JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8"));
 assert.equal(saved.jobs[queued.buildId].state, "cancelled", "pending obligation survives every entry path");
 const stop = JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8"));
 assert.notEqual(stop.recovery?.state, "pending", "clear the obligation only after the cancellation save");
 assert.equal(existsSync(join(f.dir, "calls")), false, "maintenance must not invoke a model");
});

async function pendingRecovery(t: any) {
 const f = await fixture(t), model = blockingModel(f), resident = await f.manage("ensure");
 const queued = await controlRequest(f.store, { ...request("maintenance-queued"), options: { nextAt: new Date(Date.now() + 3600000).toISOString() } });
 process.kill(resident.pid, "SIGKILL");
 await until(() => { try { process.kill(resident.pid, 0); return false; } catch { return true; } }, "synthetic resident did not end");
 const generation = randomUUID();
 writeFileSync(join(f.store, "stop.json"), JSON.stringify({ generation, recovery: { generation, state: "pending" } }));
 return { ...f, model, queued, generation };
}

for (const corrupt of ["{", JSON.stringify({ generation: "invalid", recovery: { state: "pending" } })]) test(`Arc stop repairs a corrupt fence and reports its uncertainty once (${corrupt})`, async t => {
 const f = await pendingRecovery(t); writeFileSync(join(f.store, "stop.json"), corrupt);
 const result = await f.manage("stop");
 assert.equal(result.state, "stopped", JSON.stringify(result));
 assert.equal(result.recoveryUncertainty, "unknown-prior-stop");
 assert.equal(serviceText(result), "Arc stop on synthetic could not read the record of an earlier stop, so it cancelled the queued Builds.\nThis command sent no signal. AmPi does not know which signals the earlier stop sent.\nThe earlier stop may have interrupted a Build, and another Arc service may have started one. Either may have charged a model call.\nCheck your model provider\'s usage page.");
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[f.queued.buildId].state, "cancelled");
 assert.equal(JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8")).recovery, undefined);
 assert.equal(JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8")).uncertainty, undefined);
 assert.match(readFileSync(join(f.store, "service.log"), "utf8"), /Arc stop: the record of an earlier stop is unreadable/);
 for (let attempt = 0; attempt < 2; attempt++) {
  const later = await f.manage("status");
  assert.equal(later.state, "stopped"); assert.equal(later.recoveryUncertainty, undefined);
  assert.equal(serviceText(later), "synthetic: Arc service is stopped. A linked hub restarts it within seconds.");
 }
 assert.equal(existsSync(f.model.calls), false);
});

for (const capture of ["before-corruption", "pending-generation"]) test(`Arc corrupt recovery fences an ensure captured at ${capture}`, async t => {
 const f = await pendingRecovery(t), gate = join(f.dir, "corrupt-admission.sock"), server = createServer();
 t.after(() => server.close()); await new Promise<void>(resolve => server.listen(gate, resolve));
 const connected = once(server, "connection"), seam = "\tlet staging,";
 assert.equal(f.body.split(seam).length, 2);
 if (capture === "pending-generation") {
  const state = JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8"));
  writeFileSync(join(f.store, "stop.json"), JSON.stringify({ ...state, uncertainty: "unknown-prior-stop" }));
 }
 const pause = `if(operation.op==='ensure' && process.env.ADMISSION_GATE==='1') {const {createConnection}=await import('node:net');await new Promise((resolve,reject)=>{const socket=createConnection(${JSON.stringify(gate)});socket.once('connect',()=>socket.write('admitted'));socket.once('end',resolve);socket.once('error',reject);});}\n`;
 writeFileSync(f.bundle, f.body.replace(seam, pause + seam));
 const pending = f.manage("ensure", {}, false, { ADMISSION_GATE: "1" });
 const [socket] = await connected; t.after(() => socket.destroy()); await once(socket, "data");
 if (capture === "before-corruption") writeFileSync(join(f.store, "stop.json"), "{");
 assert.equal((await f.manage("stop")).state, "stopped");
 socket.end(); const stale = await pending;
 assert.equal(stale.state, "stopped"); assert.equal(stale.running, false);
 assert.equal(stale.recoveryUncertainty, undefined);
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[f.queued.buildId].state, "cancelled");
 assert.equal(existsSync(f.model.calls), false);
});

test("Arc corrupt recovery distinguishes saved cancellation from a failed completion record", async t => {
 const f = await pendingRecovery(t), repair = join(f.dir, "completion-repaired"), seam = "function completeRecovery(lock, generation) {";
 writeFileSync(join(f.store, "stop.json"), "{"); assert.ok(f.body.includes(seam));
 writeFileSync(f.bundle, `import {existsSync as completionRepaired} from 'node:fs';\n` + f.body.replace(seam, seam + `if(!completionRepaired(${JSON.stringify(repair)})) throw new Error('synthetic completion write failure');`));
 const result = await f.manage("stop"); assert.equal(result.state, "fault"); assert.equal(result.running, true);
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[f.queued.buildId].state, "cancelled");
 assert.equal(JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8")).recovery.state, "pending");
 assert.equal(result.cancellationPersisted, true);
 assert.equal(serviceText(result), `Arc stop on synthetic could not recover: the record of an earlier stop is unreadable, and synthetic completion write failure.\nThis command sent no signal. Queued Builds are cancelled. AmPi could not save the final stop record.\nThe earlier stop may have interrupted a Build, and another Arc service may have started one. Either may have charged a model call.\nRepair ${realpathSync(f.store)}: synthetic completion write failure; then run ampi arc stop --host synthetic again.`);
 assert.doesNotMatch(serviceText(result), /not cancelled/);
 writeFileSync(repair, "ok"); assert.equal((await f.manage("stop")).state, "stopped"); assert.equal(existsSync(f.model.calls), false);
});

for (const errno of ["EACCES", "EIO"]) test(`Arc stop does not replace an unreadable fence on ${errno}`, async t => {
 const f = await pendingRecovery(t), repair = join(f.dir, "read-repaired"), original = readFileSync(join(f.store, "stop.json"), "utf8"), seam = "function readStop(store) {";
 assert.ok(f.body.includes(seam));
 writeFileSync(f.bundle, `import {existsSync as readRepaired} from 'node:fs';\n` + f.body.replace(seam, seam + `if(!readRepaired(${JSON.stringify(repair)})) throw Object.assign(new Error('synthetic ${errno} reading stop.json'),{code:'${errno}'});`));
 const result = await f.manage("stop");
 assert.equal(result.state, "fault"); assert.equal(result.running, true); assert.equal(result.recoveryUncertainty, undefined);
 assert.equal(readFileSync(join(f.store, "stop.json"), "utf8"), original);
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[f.queued.buildId].state, "queued");
 assert.match(result.recoveryFault, new RegExp(errno));
 writeFileSync(repair, "ok"); assert.equal((await f.manage("stop")).state, "stopped");
 assert.equal(existsSync(f.model.calls), false);
});

for (const phase of ["before-rename", "after-rename", "cancel-save"]) test(`Arc corrupt recovery retains no-work authority on ${phase} failure`, async t => {
 const f = await pendingRecovery(t), repair = join(f.dir, "repair-corruption");
 writeFileSync(join(f.store, "stop.json"), "{");
 let body = `import {existsSync as repairedFence} from 'node:fs';\n` + f.body;
 const seam = phase === "before-rename" ? "renameSync(temporary, target);" : phase === "after-rename" ? 'fd = openSync(lock.store, "r");' : "function durableJson(lock, name, value) {";
 const condition = phase === "cancel-save" ? `name === 'builder.json' && value.jobs[${JSON.stringify(f.queued.buildId)}]?.state === 'cancelled'` : "name === 'stop.json'";
 const fault = `synthetic ${phase} write failure`;
 assert.ok(body.includes(seam));
 const injection = `if (${condition} && !repairedFence(${JSON.stringify(repair)})) throw new Error(${JSON.stringify(fault)});`;
 body = body.replace(seam, phase === "cancel-save" ? seam + injection : injection + seam);
 writeFileSync(f.bundle, body);
 const result = await f.manage("stop");
 assert.equal(result.state, "fault", JSON.stringify(result)); assert.equal(result.running, true);
 assert.equal(result.recoveryUncertainty, "unknown-prior-stop");
 assert.equal(serviceText(result), `Arc stop on synthetic could not recover: the record of an earlier stop is unreadable, and ${fault}.\nThis command sent no signal. Queued Builds are not cancelled and may still run.\nThe earlier stop may have interrupted a Build, and another Arc service may have started one. Either may have charged a model call.\nRepair ${realpathSync(f.store)}: ${fault}; then run ampi arc stop --host synthetic again.`);
 const probe = launchLocked(f.store, ["-e", "process.exit(0)"], { stdio: "ignore" });
 assert.equal((await once(probe, "close"))[0], LOCK_BUSY);
 await f.manage("ensure").then(ensured => assert.equal(ensured.pid, result.pid), error => assert.match(error.message, /Cannot read Arc stop fence/));
 assert.equal((await controlRequest(f.store, request("corrupt-must-not-start"))).outcome, "refused");
 assert.equal((await f.manage("stop")).pid, result.pid);
 writeFileSync(repair, "ok");
 for (let attempt = 0; attempt < 2; attempt++) {
  const retried = await f.manage("stop"); assert.equal(retried.state, "stopped"); assert.equal(retried.recoveryUncertainty, attempt === 0 ? "unknown-prior-stop" : undefined);
  assert.equal(JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8")).uncertainty, undefined);
 }
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[f.queued.buildId].state, "cancelled");
 assert.equal(existsSync(f.model.calls), false);
});

for (const phase of ["before-rename", "after-rename", "after-cancel-save", "after-completion"]) test(`Arc corrupt recovery survives crash ${phase}`, async t => {
 const f = await pendingRecovery(t); writeFileSync(join(f.store, "stop.json"), "{");
 let body = f.body;
 const seam = phase === "before-rename" ? "renameSync(temporary, target);" : phase === "after-rename" ? 'fd = openSync(lock.store, "r");' : phase === "after-cancel-save" ? "function completeRecovery(lock, generation) {" : "completeRecovery(lock, options.maintenance.generation);";
 assert.ok(body.includes(seam), seam);
 const injection = (phase.includes("rename") ? "if(name === 'stop.json') " : "") + "process.kill(process.pid, 'SIGKILL');";
 body = body.replace(seam, ["after-cancel-save", "after-completion"].includes(phase) ? seam + injection : injection + seam);
 writeFileSync(f.bundle, body);
 const child = launchLocked(f.store, [f.bundle, "_locked", JSON.stringify({ op: "stop", host: "synthetic", agentDir: f.agent })], { stdio: ["ignore", "pipe", "ignore"] });
 t.after(() => child.kill("SIGKILL")); child.stdout!.resume(); await once(child, "close");
 if (phase === "before-rename") assert.equal(readFileSync(join(f.store, "stop.json"), "utf8"), "{");
 else {
  const stop = JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8")); assert.equal(stop.uncertainty, phase === "after-completion" ? undefined : "unknown-prior-stop");
  assert.equal(stop.recovery?.state, phase === "after-completion" ? undefined : "pending");
 }
 writeFileSync(f.bundle, f.body);
 for (let attempt = 0; attempt < 2; attempt++) {
  // A crash after completion loses the one report; service.log keeps the trace.
  const result = await f.manage("stop"); assert.equal(result.state, "stopped"); assert.equal(result.recoveryUncertainty, attempt === 0 && phase !== "after-completion" ? "unknown-prior-stop" : undefined);
  assert.equal(JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8")).uncertainty, undefined);
 }
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[f.queued.buildId].state, "cancelled");
 assert.equal(existsSync(f.model.calls), false);
});

for (const phase of ["before-cancel-save", "after-cancel-save"]) test(`Arc pending recovery survives a crash ${phase}`, async t => {
 const f = await pendingRecovery(t), seam = "function durableJson(lock, name, value) {";
 assert.ok(f.body.includes(seam));
 const condition = phase === "before-cancel-save" ? `name === 'builder.json' && value.jobs[${JSON.stringify(f.queued.buildId)}]?.state === 'cancelled'` : "name === 'stop.json' && !value.recovery";
 writeFileSync(f.bundle, f.body.replace(seam, seam + `if (${condition}) process.kill(process.pid, 'SIGKILL');`));
 const child = launchLocked(f.store, [f.bundle, "_locked", JSON.stringify({ op: "ensure", host: "synthetic", agentDir: f.agent, storeIncarnation: storeIncarnation(f.store) })], { stdio: ["ignore", "pipe", "ignore"] });
 t.after(() => child.kill("SIGKILL")); child.stdout!.resume(); await once(child, "close");
 assert.equal(JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8")).recovery.state, "pending");
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[f.queued.buildId].state, phase === "before-cancel-save" ? "queued" : "cancelled");
 writeFileSync(f.bundle, f.body);
 assert.equal((await f.manage("stop")).state, "stopped");
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[f.queued.buildId].state, "cancelled");
 assert.equal(JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8")).recovery, undefined);
 assert.equal(existsSync(f.model.calls), false);
});

test("Arc pending recovery retains a responsive fault owner until cancellation persistence succeeds", async t => {
 const f = await pendingRecovery(t), repair = join(f.dir, "storage-repaired"), seam = "function durableJson(lock, name, value) {";
 assert.ok(f.body.includes(seam));
 writeFileSync(f.bundle, `import { existsSync as recoveryRepaired } from 'node:fs';\n` + f.body.replace(seam, seam + `if (name === 'builder.json' && value.jobs[${JSON.stringify(f.queued.buildId)}]?.state === 'cancelled' && !recoveryRepaired(${JSON.stringify(repair)})) throw new Error('synthetic cancellation storage failure');`));
 const failed = await f.manage("stop");
 assert.equal(failed.state, "fault"); assert.equal(failed.running, true); assert.equal(failed.kind, "forced-recovery");
 assert.equal(failed.recoveryAction, `Repair ${realpathSync(f.store)}: synthetic cancellation storage failure; then run ampi arc stop --host synthetic again.`); process.kill(failed.pid, 0);
 const generation = JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8")).generation;
 assert.equal((await f.manage("ensure")).pid, failed.pid, "ensure must not offer a replacement to the fault owner");
 assert.equal((await rawControlRequest(f.store, { op: "offer", stamp: { id: f.version2, order: 200, line: "stable" } })).state, "fault", "an offer cannot replace a pending cancellation owner");
 assert.equal((await f.manage("stop")).pid, failed.pid, "retry must retain the same authority while storage is broken");
 assert.equal(JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8")).generation, generation);
 const probe = launchLocked(f.store, ["-e", "process.exit(0)"], { stdio: "ignore" });
 assert.equal((await once(probe, "close"))[0], LOCK_BUSY, "fault owner retains its lifetime lock");
 assert.equal((await controlRequest(f.store, request("must-not-start"))).outcome, "refused");
 writeFileSync(repair, "repaired");
 assert.equal((await f.manage("stop")).state, "stopped");
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[f.queued.buildId].state, "cancelled");
 assert.equal(JSON.parse(readFileSync(join(f.store, "stop.json"), "utf8")).recovery, undefined);
 assert.equal(existsSync(f.model.calls), false);
});

test("Arc pending recovery performs no scan, auth, model, or admission work", async t => {
 const f = await pendingRecovery(t), touched = join(f.dir, "maintenance-work");
 let body = `import { appendFileSync as recordMaintenanceWork } from 'node:fs';\n` + f.body;
 for (const seam of ["async function scan(signal) {", "async function preflight(exact, signal) {", "async acquire() {"]) {
  assert.ok(body.includes(seam), seam);
  body = body.replace(seam, seam + `recordMaintenanceWork(${JSON.stringify(touched)}, ${JSON.stringify(seam)}); throw new Error('maintenance started work');`);
 }
 writeFileSync(f.bundle, body);
 assert.equal((await f.manage("stop")).state, "stopped");
 assert.equal(existsSync(touched), false); assert.equal(existsSync(f.model.calls), false);
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[f.queued.buildId].state, "cancelled");
});

test("Arc pending recovery survives manager death before maintenance readiness", async t => {
 const f = await pendingRecovery(t), entered = join(f.dir, "maintenance-entered"), managerPid = join(f.dir, "maintenance-manager");
 const runner = join(f.dir, "runner.mjs"), seam = "function durableJson(lock, name, value) {";
 writeFileSync(runner, `import {writeFileSync as recordManager} from 'node:fs';recordManager(${JSON.stringify(managerPid)}, String(process.pid));\n` + readFileSync(runner, "utf8"));
 writeFileSync(f.bundle, `import {writeFileSync as recordMaintenance} from 'node:fs';\n` + f.body.replace(seam, seam + `if(name === 'builder.json'){recordMaintenance(${JSON.stringify(entered)},String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}`));
 const pending = assert.rejects(f.manage("stop"));
 await until(() => existsSync(entered), "maintenance did not enter Builder initialization");
 const childPid = Number(readFileSync(entered, "utf8")); f.pids.add(childPid);
 process.kill(Number(readFileSync(managerPid, "utf8")), "SIGKILL"); await pending;
 writeFileSync(f.bundle, f.body);
 assert.equal((await f.manage("stop")).state, "stopped");
 assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[f.queued.buildId].state, "cancelled");
 assert.equal(existsSync(f.model.calls), false);
});

for (const competitor of ["dispatch", "exit", "hold"]) test(`Arc forced recovery reports an acquisition gap when a competitor can ${competitor}`, { timeout: 20000, skip: process.platform !== "linux" }, async t => {
 const f = await fixture(t), model = blockingModel(f), paused = join(f.dir, "recovery-paused"), release = join(f.dir, "recovery-release");
 f.settings({ concurrency: 2 });
 const source = readFileSync(join(f.agent, "sessions", "session.jsonl"), "utf8");
 writeFileSync(join(f.agent, "sessions", "other.jsonl"), source.replace('"id":"fixture-session"', '"id":"other-session"'));
 const resident = await f.manage("ensure");
 await controlRequest(f.store, request("gap-paid-survivor"));
 await until(() => existsSync(model.pid), "paid survivor did not start");
 const survivor = Number(readFileSync(model.pid, "utf8")); f.pids.add(survivor);
 const queued = await controlRequest(f.store, { ...request("gap-queued"), sessionRef: "pi:other-session", options: { nextAt: new Date(Date.now() + 3600000).toISOString() } });
 const { statSync } = await import("node:fs"), inode = statSync(join(f.store, "service.lock")).ino;
 const seam = "command.forcedRecovery = true;";
 assert.ok(f.body.includes(seam), "recovery must expose its post-signal normal-acquisition boundary");
 writeFileSync(f.bundle, `import {writeFileSync as markGap, existsSync as gapReleased} from 'node:fs';\n` + f.body.replace(seam, seam + `markGap(${JSON.stringify(paused)},'paused');while(!gapReleased(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10));`));
 process.kill(resident.pid, "SIGSTOP"); rmSync(serviceAddress(f.store));
 const pending = f.manage("stop", { timeoutMs: 10000 });
 await until(() => existsSync(paused), "recovery did not reach its acquisition gap");
 writeFileSync(f.bundle, f.body);
 let releaseRetainer: (() => Promise<void>) | undefined;
 const retainerSignals = join(f.dir, "retainer-signals");
 if (competitor === "dispatch") {
  const path = join(f.store, "builder.json"), saved = JSON.parse(readFileSync(path, "utf8"));
  saved.jobs[queued.buildId].nextAt = new Date(0).toISOString(); writeFileSync(path, JSON.stringify(saved));
  const successor = await f.manage("ensure"); assert.notEqual(successor.pid, resident.pid);
  await until(() => readFileSync(model.calls, "utf8").split("call\n").length === 3, "successor did not dispatch the other Session");
  f.pids.add(Number(readFileSync(model.pid, "utf8")));
 } else {
  const body = competitor === "hold" ? `process.on('SIGTERM',()=>require('node:fs').appendFileSync(${JSON.stringify(retainerSignals)},'TERM'));process.stdout.write('acquired');setInterval(()=>{},1000);` : "process.stdout.write('acquired');";
  const child = launchLocked(f.store, ["-e", body], { stdio: ["ignore", "pipe", "ignore"] });
  const ended = once(child, "close");
  releaseRetainer = async () => { child.kill("SIGKILL"); await ended; }; t.after(releaseRetainer);
  let output = ""; child.stdout!.on("data", bytes => output += bytes);
  if (competitor === "hold") await once(child.stdout!, "data"); else await ended;
  assert.equal(output, "acquired");
 }
 writeFileSync(release, "release");
 const result = await pending;
 assert.equal(result.kind, "forced-recovery"); assert.equal(result.recovery.pid, resident.pid);
 assert.equal(result.recovery.interveningDispatch, "unknown");
 if (competitor === "hold") {
  assert.equal(result.recovery.cancellation, "unconfirmed"); assert.notEqual(result.state, "stopped");
  assert.equal(existsSync(retainerSignals), false, "recovery never retargets a foreign lock holder");
  await releaseRetainer!();
 }
 assert.match(serviceText(result), /another Arc service may also have started a Build/i);
 assert.doesNotMatch(serviceText(result), /zero new calls|no intervening owner/i);
 assert.equal(statSync(join(f.store, "service.lock")).ino, inode); process.kill(survivor, 0);
 const restarted = await f.manage("ensure"); assert.ok(restarted.runningBuilds >= 1, "the paid survivor still consumes capacity");
});

test("Arc recovery reports an orderly stop without a signal", async t => {
 const f = await fixture(t); await f.manage("ensure");
 const reply = await f.manage("stop");
 assert.equal(reply.state, "stopped");
 assert.equal(serviceText(reply), "Arc service on synthetic stopped. A linked hub starts it again within seconds.");
 assert.doesNotMatch(JSON.stringify(reply), /SIGTERM|SIGKILL/);
});

test("Arc recovery reports a free lock without signalling an absent service", async t => {
 const f = await fixture(t), reply = await f.manage("stop");
 assert.equal(reply.state, "stopped");
 assert.equal(serviceText(reply), "Arc service on synthetic is not running. Nothing to stop. No signal sent.");
});

test("Arc recovery refuses coarse Mac identity without signalling the silent owner", { skip: process.platform !== "darwin" }, async t => {
 const f = await fixture(t), resident = await f.manage("ensure");
 process.kill(resident.pid, "SIGSTOP"); rmSync(serviceAddress(f.store));
 const reply = await f.manage("stop", { timeoutMs: 500 });
 assert.notEqual(reply.state, "stopped");
 assert.equal(serviceText(reply), `Refused on macOS: pid ${resident.pid} matches the Arc service for ${f.store} and has its lock file open, but macOS cannot prove that it holds the lock. No signal sent. To stop it anyway, run \`ampi arc stop --host synthetic --force-unverified\`.`);
 process.kill(resident.pid, 0);
 const state = spawnSync("/bin/ps", ["-p", String(resident.pid), "-o", "stat="], { encoding: "utf8" });
 assert.match(state.stdout, /T/, "the silent owner remains suspended");
});

for (const frozen of [false, true]) test(`Arc recovery stops a matched Mac owner only with --force-unverified and cancels queued work (frozen=${frozen})`, { timeout: 25000, skip: process.platform !== "darwin" }, async t => {
 const f = await fixture(t), model = blockingModel(f), poll = "options.pollMs ?? 2e3";
 assert.ok(f.body.includes(poll));
 // Keep the synthetic legacy owner from detecting its missing socket first.
 writeFileSync(f.bundle, f.body.replace(poll, "options.pollMs ?? 60000"));
 const resident = await f.manage("ensure"), lockPath = join(f.store, "service.lock");
 const queued = await controlRequest(f.store, { ...request("mac-queued"), options: { nextAt: new Date(Date.now() + 3600000).toISOString() } });
 assert.equal(queued.outcome, "accepted");
 const { statSync } = await import("node:fs"), inode = statSync(lockPath).ino;
 if (frozen) process.kill(resident.pid, "SIGSTOP");
 rmSync(serviceAddress(f.store));
 const recovered = await f.manage("stop", { timeoutMs: 10000, forceUnverified: true });
 assert.equal(recovered.state, "stopped"); assert.equal(recovered.kind, "forced-recovery");
 assert.equal(recovered.recovery.pid, resident.pid); assert.equal(recovered.recovery.evidence, "unverified");
 assert.equal(recovered.recovery.cancellation, "confirmed"); assert.equal(recovered.recovery.interveningDispatch, "unknown");
 assert.deepEqual(recovered.recovery.signals, frozen ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
 assert.match(serviceText(recovered), new RegExp(`macOS could not prove that pid ${resident.pid} held the lock\\. You chose to stop it anyway\\.`));
 assert.match(serviceText(recovered), /may have charged a model call/);
 assert.throws(() => process.kill(resident.pid, 0), { code: "ESRCH" });
 assert.equal(statSync(lockPath).ino, inode, "recovery must keep the lifetime-lock inode");
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[queued.buildId].state, "cancelled");
 const restarted = await f.manage("ensure"); assert.equal(restarted.running, true); assert.notEqual(restarted.pid, resident.pid);
 assert.equal(existsSync(model.calls), false, "the cancelled Build never calls the model");
 assert.equal((await f.manage("stop")).state, "stopped");
});

test("Arc recovery reads process identity in C under a non-C parent locale", { skip: process.platform !== "darwin" }, async t => {
 const f = await fixture(t), resident = await f.manage("ensure"), reads = join(f.dir, "identity-locales"), preload = join(f.dir, "identity-locale.mjs");
 writeFileSync(preload, `import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {appendFileSync} from 'node:fs';
 const original=childProcess.execFile;childProcess.execFile=function(file,args,options,...rest){
  if(file==='/bin/ps'||file==='/usr/sbin/lsof') appendFileSync(${JSON.stringify(reads)},JSON.stringify({file,locale:options?.env?.LC_ALL??process.env.LC_ALL})+'\\n');
  return original.call(this,file,args,options,...rest);
 };childProcess.execFile[Symbol.for('nodejs.util.promisify.custom')]=(file,args,options)=>new Promise((resolve,reject)=>childProcess.execFile(file,args,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));syncBuiltinESMExports();`);
 process.kill(resident.pid, "SIGSTOP"); rmSync(serviceAddress(f.store));
 const reply = await f.manage("stop", { timeoutMs: 700 }, false, { LC_ALL: "zh_CN.UTF-8", LANG: "zh_CN.UTF-8", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
 assert.match(serviceText(reply), new RegExp(`Refused on macOS: pid ${resident.pid} matches`));
 const observed = readFileSync(reads, "utf8").trim().split("\n").map(line => JSON.parse(line));
 assert.ok(observed.some(row => row.file === "/bin/ps")); assert.ok(observed.some(row => row.file === "/usr/sbin/lsof"));
 assert.ok(observed.every(row => row.locale === "C"), JSON.stringify(observed)); process.kill(resident.pid, 0);
});

test("Arc recovery refuses two exact-store openers instead of guessing the flock owner", { skip: process.platform !== "darwin" }, async t => {
 const f = await fixture(t), resident = await f.manage("ensure"), script = join(f.store, `launch-${randomUUID()}.mjs`), signals = join(f.dir, "extra-opener-signals");
 process.kill(resident.pid, "SIGSTOP"); rmSync(serviceAddress(f.store));
 writeFileSync(script, `import {openSync,appendFileSync} from 'node:fs';openSync(${JSON.stringify(join(f.store, "service.lock"))},'r+');process.on('SIGTERM',()=>appendFileSync(${JSON.stringify(signals)},'TERM\\n'));console.log('ready');setInterval(()=>{},1000);`);
 const decoy = spawn(process.execPath, [script, "_locked", JSON.stringify({ op: "ensure", host: "synthetic", agentDir: f.agent, storeIncarnation: storeIncarnation(f.store) })], { stdio: ["ignore", "pipe", "ignore"] });
 t.after(() => decoy.kill("SIGKILL")); await once(decoy.stdout!, "data");
 const reply = await f.manage("stop", { timeoutMs: 500 });
 assert.notEqual(reply.state, "stopped");
 assert.match(serviceText(reply), /Refused: 2 processes match the Arc service/);
 assert.match(serviceText(reply), /No signal sent\./);
 assert.equal(existsSync(signals), false); process.kill(resident.pid, 0); process.kill(decoy.pid!, 0);
});

test("Arc recovery never signals a foreign-store decoy that holds the exact lock inode", async t => {
 const f = await fixture(t), other = join(f.dir, "other-agent"), script = join(other, "ampi-arc", `launch-${randomUUID()}.mjs`), signals = join(f.dir, "decoy-signals");
 mkdirSync(join(other, "ampi-arc"), { recursive: true });
 writeFileSync(script, `import {appendFileSync} from 'node:fs';process.on('SIGTERM',()=>appendFileSync(${JSON.stringify(signals)},'TERM\\n'));console.log('ready');setInterval(()=>{},1000);`);
 const decoy = launchLocked(f.store, [script, "_locked", JSON.stringify({ op: "ensure", agentDir: other })], { stdio: ["ignore", "pipe", "ignore"] });
 t.after(() => decoy.kill("SIGKILL"));
 await once(decoy.stdout!, "data");
 const reply = await f.manage("stop", { timeoutMs: 400 });
 assert.notEqual(reply.state, "stopped");
 assert.match(serviceText(reply), /serves a different store/);
 assert.match(serviceText(reply), /No signal sent\./);
 assert.equal(existsSync(signals), false, "a path mention does not authorize signalling another store");
 process.kill(decoy.pid!, 0);
});

test("Arc recovery reports a held lock without an Arc candidate and sends no signal", async t => {
 const f = await fixture(t);
 const holder = launchLocked(f.store, ["-e", "console.log('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
 t.after(() => holder.kill("SIGKILL")); await once(holder.stdout!, "data");
 const reply = await f.manage("stop", { timeoutMs: 500 });
 assert.notEqual(reply.state, "stopped");
 assert.match(serviceText(reply), /^Refused: the Arc lock is held, but no Arc service process matches it\. No signal sent\./);
 assert.match(serviceText(reply), /If the next Build still reports busy, (end pid \d+ or )?restart the machine synthetic\.$/);
 process.kill(holder.pid!, 0);
});

test("Arc recovery halts before SIGKILL when the verified command identity changes", { skip: process.platform !== "linux" }, async t => {
 const f = await fixture(t), script = join(f.store, `launch-${randomUUID()}.mjs`), signals = join(f.dir, "changed-signals");
 mkdirSync(f.store, { recursive: true });
 writeFileSync(script, `import {appendFileSync} from 'node:fs';process.on('SIGTERM',()=>{appendFileSync(${JSON.stringify(signals)},'TERM\\n');process.title='synthetic-changed-process';});console.log('ready');setInterval(()=>{},1000);`);
 const incarnation = storeIncarnation(f.store, true);
 const holder = launchLocked(f.store, [script, "_locked", JSON.stringify({ op: "ensure", host: "synthetic", agentDir: f.agent, storeIncarnation: incarnation })], { stdio: ["ignore", "pipe", "ignore"] });
 t.after(() => holder.kill("SIGKILL")); await once(holder.stdout!, "data");
 const reply = await f.manage("stop", { timeoutMs: 5000 });
 assert.notEqual(reply.state, "stopped");
 assert.equal(serviceText(reply), `Recovery halted: pid ${holder.pid} changed before the next signal.\nSent SIGTERM only. AmPi cannot confirm that the old Arc service stopped.\nA Build that the signals interrupted may have charged a model call. Another Arc service may also have started a Build and charged one.\nRun ampi arc stop --host synthetic again.`);
 assert.equal(readFileSync(signals, "utf8"), "TERM\n"); process.kill(holder.pid!, 0);
});

test("Arc recovery: a Mac open lock fd without a flock owner is never signal authority", { skip: process.platform !== "darwin" }, async t => {
 const f = await fixture(t); await f.manage("ensure"); await f.manage("stop");
 const lockPath = join(f.store, "service.lock"), signals = join(f.dir, "open-fd-signals");
 const decoy = spawn(process.execPath, ["-e", `const fs=require('node:fs');fs.openSync(process.argv[1],'r+');process.on('SIGTERM',()=>fs.appendFileSync(process.argv[2],'TERM\\n'));console.log('ready');setInterval(()=>{},1000);`, lockPath, signals], { stdio: ["ignore", "pipe", "ignore"] });
 t.after(() => decoy.kill("SIGKILL")); await once(decoy.stdout!, "data");
 const files = spawnSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(decoy.pid), "-F0pfl", "--", lockPath], { encoding: "utf8", timeout: 3000 });
 assert.equal(files.status, 0); assert.match(files.stdout, new RegExp(`p${decoy.pid}\\x00`));
 assert.ok(!/l[RW]/.test(files.stdout), "lsof has no exclusive lock evidence");
 assert.equal((await f.manage("stop", { timeoutMs: 1000 })).state, "stopped");
 assert.equal(existsSync(signals), false); process.kill(decoy.pid!, 0);
});

