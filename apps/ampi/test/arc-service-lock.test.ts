import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { launchLocked, LOCK_BUSY } from "../src/arc/service/lock.ts";
import { compare, validStamp } from "../src/arc/service/engine.ts";

const lockModule = new URL("../src/arc/service/lock.ts", import.meta.url).href;
const storeModule = new URL("../src/arc/service/store.ts", import.meta.url).href;
function fixture() {
 const root = mkdtempSync(join(tmpdir(), "arc-lock-test-"));
 const store = join(root, "store");
 const script = join(root, "probe.mjs");
 writeFileSync(script, `import { inheritedLock } from ${JSON.stringify(lockModule)};
import { controlStore } from ${JSON.stringify(storeModule)};
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
const lock = inheritedLock(), control = controlStore(lock);
const command = JSON.parse(process.argv[2]);
if (command.hold) {
 const childCode = \`const fs = require('node:fs');
const named = fs.statSync(process.env.AMPI_ARC_STORE + '/service.lock');
let inherited = false;
try { const open = fs.fstatSync(Number(process.env.AMPI_ARC_LOCK_FD)); inherited = open.ino === named.ino && open.dev === named.dev; } catch {}
fs.writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,inherited}));
setInterval(() => {},1000);\`;
 const child = spawn(process.execPath, ['-e', childCode, command.ready + '.child'], {stdio:'ignore'});
 child.unref();
 writeFileSync(command.ready, JSON.stringify({pid:process.pid,child:child.pid}));
 setInterval(() => lock.assertHeld(),1000);
} else {
 const result = command.select ? control.select(command.select) : control.read();
 console.log(JSON.stringify(result));
}
`);
 return { root, store, script, clean: () => rmSync(root, { recursive: true, force: true }) };
}
function start(f: ReturnType<typeof fixture>, command: object) {
 const child = launchLocked(f.store, [f.script, JSON.stringify(command)], { stdio: ["ignore", "pipe", "pipe"] });
 let out = "", error = "";
 child.stdout!.on("data", b => { out += b; }); child.stderr!.on("data", b => { error += b; });
 const done = once(child, "close").then(([code, signal]) => ({ code, signal, out, error }));
 return { child, done };
}
async function probe(f: ReturnType<typeof fixture>, command: object) {
 const result = await start(f, command).done;
 assert.equal(result.code, 0, result.error);
 return JSON.parse(result.out);
}
async function readReady(path: string): Promise<{ pid: number; child?: number; inherited?: boolean }> {
 const end = Date.now() + 5000;
 while (Date.now() < end) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch {}
  await new Promise(r => setTimeout(r, 10));
 }
 throw new Error("Arc launcher probe did not become ready");
}
function kill(pid: number, signal: NodeJS.Signals = "SIGKILL") { try { process.kill(pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } }

test("Arc lifetime lock: exec and SIGSTOP exclude contenders; Node death releases despite a surviving model child", async () => {
 const f = fixture(), ready = join(f.root, "ready");
 const owner = start(f, { hold: true, ready });
 let modelPid: number | undefined;
 try {
  const running = await readReady(ready);
  modelPid = running.child;
  const model = await readReady(ready + ".child");
  assert.equal(model.pid, modelPid);
  assert.equal(running.pid, owner.child.pid, "Perl must exec Node, not remain a supervisor");
  assert.equal(model.inherited, false, "Model children must not hold the lifetime lock");
  const inode = statSync(join(f.store, "service.lock")).ino;
  assert.equal((await start(f, {}).done).code, LOCK_BUSY);
  kill(running.pid, "SIGSTOP");
  assert.equal((await start(f, {}).done).code, LOCK_BUSY, "A stopped owner still excludes another service");
  kill(running.pid);
  await owner.done;
  process.kill(model.pid, 0);
  assert.deepEqual(await probe(f, {}), {}, "SIGKILL releases the lock even while the model survives");
  assert.equal(statSync(join(f.store, "service.lock")).ino, inode, "Takeover must preserve the lock inode");
 } finally { if (owner.child.pid) kill(owner.child.pid); if (modelPid) kill(modelPid); await owner.done; f.clean(); }
});

test("Arc build order: identity is equal; time then ID orders every pair across lines", () => {
 const a = { id: "a", order: 10, line: "stable" }, b = { id: "b", order: 10, line: "durable" };
 assert.equal(compare(a, { ...a, order: 20, line: "durable" }), "same");
 assert.equal(compare(a, b), "older"); assert.equal(compare(b, a), "newer");
 assert.equal(compare({ ...a, order: 11 }, b), "newer");
 assert.equal(compare(b, { ...a, order: 11 }), "older");
 assert.equal(validStamp({ ...a, order: null }), false);
});

test("Arc control: engine selection is monotone across launcher restarts", async () => {
 const f = fixture(), engine = (id: string, order: number) => ({ id, order, line: "stable" });
 try {
  const first = engine("first", 10), newer = engine("newer", 20);
  assert.deepEqual(await probe(f, { select: first }), first);
  assert.deepEqual(await probe(f, { select: newer }), newer);
  assert.deepEqual(await probe(f, { select: first }), newer);
  assert.deepEqual((await probe(f, {})).selected, newer);
  assert.notEqual((await start(f, { select: engine("../../outside", 1000) }).done).code, 0);
 } finally { f.clean(); }
});
