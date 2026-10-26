import "./bound.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { teamPlugin } from "../src/plugins/team.ts";
import { Hub } from "../src/hub/hub.ts";
import { Browser, TestClient, tempHome } from "./helpers.ts";

const exec = promisify(execFile);
const helper = fileURLToPath(new URL("../scripts/durable/migration-check.mjs", import.meta.url));
const model = { provider: "ampi-sim", modelId: "sim-1" };

const teamPrompt = (index: number) => `/sim tool team_create {"name":"copy-${index}","purpose":"Verify copied authority"}\n/sim tool ensure_worker {"name":"builder","scope":"Keep binding"}`;

for (const teams of [0, 1, 2]) test(`migration check: stopped backup copies preserve perf authority (${teams} Teams)`, async () => {
 const dir = tempHome(), original = join(dir, "original"), proof = join(dir, "proof");
 mkdirSync(proof);
 const plugins = () => [teamPlugin()];
 const seed = await runDaemon({ home: original, simTokensPerSecond: 1e9, plugins: plugins() });
 const client = await TestClient.connect(seed.socket);
 // Each Team is a lead thread and one Worker; without a Team, one unbound thread.
 const count = teams ? teams * 2 : 1;
 try {
  if (!teams) await client.req("thread.create", { cwd: dir, model, prompt: "Synthetic idle thread" });
  for (let index = 1; index <= teams; index++) await client.req("thread.create", { cwd: dir, model, prompt: teamPrompt(index) });
  const sub = client.sub({ kind: "threads" });
  await client.until<any>(sub, (v) => Object.values(v.threads).length === count && Object.values(v.threads).every((t: any) => t.activity === "idle" && !t.queued), 15000);
 } finally { client.close(); await seed.stop(); }
 // Whole stopped home, including SQLite sidecars. Never run the helper against the seed or a live store.
 const archive = join(dir, "home.tar");
 await exec("tar", ["-C", original, "--exclude=./node.sock", "-cpf", archive, "."]);
 const counts = join(dir, "counts.json");
 writeFileSync(counts, JSON.stringify({ threadCount: count, teamCount: teams, workerCount: teams }));
 for (const mode of ["before", "after"]) {
  const copy = join(dir, mode); mkdirSync(copy);
  await exec("tar", ["-C", copy, "-xpf", archive]);
  await exec("diff", ["-qr", join(original, "threads"), join(copy, "threads")]);
  const node = await runDaemon({ home: copy, simTokensPerSecond: 1e9, plugins: plugins() });
  const check = (stage: string, path = proof, approved = counts) => exec(process.execPath, [helper, path, stage, ...(stage === "before" ? [approved] : [])], { env: { ...process.env, AMPI_HOME: copy }, timeout: 20000 });
  // Edits one private baseline file, expects the after check to stop with `message`, then restores the file.
  const stopsAfter = async (file: string, edit: (text: string) => string, message: RegExp) => {
   const path = join(proof, file), saved = readFileSync(path, "utf8");
   writeFileSync(path, edit(saved));
   await assert.rejects(check("after"), message);
   writeFileSync(path, saved);
  };
  try {
   if (mode === "before") {
    const wrong = join(dir, "wrong.json"), rejected = join(dir, "rejected");
    writeFileSync(wrong, JSON.stringify({ threadCount: count + 1, teamCount: teams, workerCount: teams }));
    await assert.rejects(check("before", rejected, wrong), /owner-approved baseline/);
    assert.equal(existsSync(join(rejected, "expected-status")), false);
    assert.match((await check(mode)).stdout, new RegExp(`PASS before: threads=${count} Teams=${teams} Workers=${teams}`));
    const selection = JSON.parse(readFileSync(join(proof, "selection.json"), "utf8"));
    assert.equal(selection.teams.length, teams, "the helper counts the Teams it compares");
    const statusFiles = readdirSync(join(proof, "expected-status")).sort();
    assert.deepEqual(statusFiles, teams ? selection.teams.map((id: string) => `${id}.txt`).sort() : ["unbound.txt"]);
    if (!teams) assert.match(readFileSync(join(proof, "expected-status", "unbound.txt"), "utf8"), /No Team is bound to this thread/);
    assert.equal(readFileSync(join(proof, "newest-worker.txt"), "utf8").trim().split("\n").length, Math.max(teams, 1));
    await assert.rejects(check("before"), /baseline already exists/);
   } else {
    assert.match((await check(mode)).stdout, new RegExp(`PASS after: threads=${count} Teams=${teams} Workers=${teams}`));
    const { teams: ids } = JSON.parse(readFileSync(join(proof, "selection.json"), "utf8"));
    const last = teams ? `Team ${teams} of ${teams}` : "the unbound thread";
    await stopsAfter(join("expected-status", `${teams ? ids.at(-1) : "unbound"}.txt`), () => "Changed Task states\n", new RegExp(`${last}: status changed`));
    await stopsAfter("expected-bindings.json", (text) => { const data = JSON.parse(text); data.at(-1).id = "changed-binding"; return JSON.stringify(data); }, /binding changed/);
    if (teams) await stopsAfter("before-facts.json", (text) => { const facts = JSON.parse(text); facts.workersByTeam[ids.at(-1)] += 1; return JSON.stringify(facts); }, new RegExp(`${last}: workerCount changed`));
    if (teams > 1) await stopsAfter("selection.json", (text) => JSON.stringify({ ...JSON.parse(text), teams: ids.slice(0, -1) }), /set of Teams changed/);
    assert.match((await check(mode)).stdout, /PASS after/, "restored baseline files pass again");
   }
  } finally { await node.stop(); }
 }
 const absent = join(dir, "absent"); mkdirSync(absent);
 await assert.rejects(exec(process.execPath, [helper, proof, "after"], { env: { ...process.env, AMPI_HOME: absent }, timeout: 20000 }), /STOP: socket ENOENT/);
 assert.equal(existsSync(join(absent, "node.sock")), false, "helper never starts a node");
});

test("migration backup: a nested hub cache must release before archive or move; both old owners recover", async () => {
 const dir = tempHome(), home = join(dir, "home"), failed = join(dir, "failed"), archive = join(dir, "home.tar");
 const probe = fileURLToPath(new URL("../scripts/durable/migration-lock-check.mjs", import.meta.url));
 const token = "d".repeat(64);
 let node = await runDaemon({ home, simTokensPerSecond: 1e9 });
 let hub: Hub | undefined, browser: Browser | undefined;
 const client = await TestClient.connect(node.socket);
 const { threadId } = await client.req("thread.create", { cwd: dir, model, prompt: "Backup continuity token" });
 await client.until<any>(client.sub({ kind: "threads" }), v => v.threads[threadId]?.activity === "idle");
 client.close();
 const openHub = async () => {
  hub = new Hub({ hosts: [{ id: "copy", label: "copy", kind: "local", home }] }, { token });
  const port = await hub.listen(0);
  browser = await Browser.open(port, undefined, `ampi_k_${port}=${token}`);
  await browser.when(() => browser!.hosts.some(h => h.id === "copy" && h.status === "connected"), 5000);
  const value = await browser.until<any>(browser.sub("copy", { kind: "thread", threadId }), v => v.entries?.some((e: any) => e.text?.includes("Backup continuity token")), 10000);
  return value.entries;
 };
 const check = (mode: string) => exec(process.execPath, [probe, mode, home, join(home, "durable-cache")], { timeout: 10000 });
 try {
  const before = await openHub();
  assert.deepEqual(JSON.parse((await check("overlap")).stdout).cacheInsideHome, [true]);
  await assert.rejects(check("stopped"), /owner lock is held/);
  writeFileSync(join(home, "autostart-off"), "hold\n");
  await node.stop();
  await assert.rejects(check("stopped"), /owner lock is held/, "stopping the node alone does not release the hub cache");
  browser!.ws.terminate(); browser = undefined;
  await hub!.close(); hub = undefined;
  assert.match((await check("stopped")).stdout, /PASS stopped: 2 owner locks released/);
  await exec("tar", ["-C", home, "--exclude=./node.sock", "-cpf", archive, "."]);
  // The same gate applies immediately before relocating the whole home.
  assert.match((await check("stopped")).stdout, /PASS stopped/);
  renameSync(home, failed); mkdirSync(home);
  await exec("tar", ["-C", home, "-xpf", archive]);
  await exec("diff", ["-qr", join(failed, "threads"), join(home, "threads")]);
  await exec("diff", ["-qr", join(failed, "durable-cache"), join(home, "durable-cache")]);
  assert.match((await check("stopped")).stdout, /PASS stopped/);
  node = await runDaemon({ home, simTokensPerSecond: 1e9 });
  const restored = await openHub();
  assert.deepEqual(restored, before, "the original node and hub recover the archived transcript");
  browser!.ws.terminate(); browser = undefined;
  await hub!.close(); hub = undefined;
  await assert.rejects(check("stopped"), /owner lock is held/, "stopping only the hub still leaves the node owner");
  await node.stop();
  assert.match((await check("stopped")).stdout, /PASS stopped: 2 owner locks released/);
 } finally { browser?.ws.terminate(); await hub?.close(); await node.stop(); }
});
