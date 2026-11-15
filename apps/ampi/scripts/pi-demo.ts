// A demo hub for building and screenshotting the one GUI without a real Host (docs/one-gui-views.md, "Demo").
// One Pi Host on this machine, fed by a fake Herdr, a fake Pi Team Bright observation module, and synthetic Pi
// Sessions spread over three days: two Teams, a 600-turn Session, compactions, a terminal error, long and non-Latin
// titles, a Session outside Herdr, and a pane waiting for input. Everything is synthetic; nothing reads real logs.
//
//   DEMO_LIFETIME=manual node apps/ampi/scripts/pi-demo.ts  # interactive; data under $TMPDIR/ampi-pi-demo
//   DEMO_LIFETIME=manual PORT=7881 DEMO_DIR=/tmp/x node apps/ampi/scripts/pi-demo.ts
//   DEMO_LIFETIME=manual DEMO_KEEP=1 DEMO_NOW=<epoch ms> ...      # a restart: keep the hub state; the base Sessions are rewritten byte-identical
//
// Views extend the data through scripts/demo/index.ts (one function per view), not by editing the base Sessions.

import "./stdio-sync.cjs";
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { ownerAlive, processIdentity } from "./process-owner.cjs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "../src/hub/hub.ts";
import { maintainHost } from "../src/arc/service/client.ts";
import { FAKE_HERDR } from "../test/pi-fixtures.ts";
import { DEMO_EXTENSIONS } from "./demo/index.ts";
import { demoDataMode } from "./demo/data/modes.ts";
import { contentArcSeed, demoFixtures, pruneDemoSessions, writeContentSessions } from "./demo/data/registry.ts";
import { seedDemoArcs } from "./demo/cos.ts";
import { writeDemoSessions, type DemoSession } from "./demo/sessions.ts";
// @ts-ignore: a plain ESM script without types
import { webDistCurrent } from "./web-inputs.mjs";

// The hub serves web/dist as it is, so a stale build would show old UI in screenshots and verify runs.
// DEMO_WEB=external: the caller serves its own build of web/src (test/resize-edges-fixture.ts) and never loads web/dist.
const web = webDistCurrent(fileURLToPath(new URL("../../../", import.meta.url)));
if (!web.ok && process.env.DEMO_WEB !== "external") {
	console.error(`pi-demo: ${web.detail}`);
	process.exit(1);
}

const manualLifetime = process.env.DEMO_LIFETIME === "manual";
const ownerIdentity = processIdentity(process.ppid);
const runnerIdentity = process.env.AMPI_TEST_RUNNER_ID;
const dataMode = demoDataMode(process.argv.slice(2));
const dir = process.env.DEMO_DIR ?? (manualLifetime ? join(tmpdir(), "ampi-pi-demo") : mkdtempSync(join(tmpdir(), "ampi-pi-demo-")));
if (!manualLifetime) {
 const group = Number(execFileSync("ps", ["-p", String(process.pid), "-o", "pgid="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim());
 if (group !== process.pid) throw new Error("Owner-bound demos require a private process group (spawn with detached: true); use DEMO_LIFETIME=manual for an interactive demo.");
 if (existsSync(join(dir, "agent/ampi-arc"))) throw new Error("Owner-bound demos require a fresh store; this DEMO_DIR already contains an Arc store. Use a new directory or DEMO_LIFETIME=manual.");
 mkdirSync(dir, { recursive: true });
 writeFileSync(join(dir, ".demo-owner"), ownerIdentity ?? "", { flag: "wx", mode: 0o600 });
} else if (process.env.DEMO_KEEP !== "1") rmSync(dir, { recursive: true, force: true });
const agentDir = join(dir, "agent");
let guardian: ReturnType<typeof spawn> | undefined;
let guardianExit: Promise<void> | undefined;
let guardianIdentity: string | null = null;
if (!manualLifetime) {
 guardian = spawn(process.execPath, [fileURLToPath(new URL("./demo/owner-guardian.ts", import.meta.url)), processIdentity(process.pid)!, ownerIdentity ?? "", runnerIdentity ?? "", agentDir], {
  detached: true, stdio: ["pipe", "pipe", "ignore"],
 });
 guardianExit = new Promise(resolve => guardian!.once("exit", () => resolve()));
 await new Promise<void>((resolve, reject) => {
  const deadline = setTimeout(() => { guardian!.kill("SIGKILL"); reject(new Error("Demo guardian did not become ready in 3 seconds")); }, 3000);
  guardian!.once("error", error => { clearTimeout(deadline); reject(error); });
  guardian!.once("exit", () => { clearTimeout(deadline); reject(new Error("Demo guardian exited before readiness")); });
  guardian!.stdout!.once("data", () => { clearTimeout(deadline); resolve(); });
 });
 guardianIdentity = processIdentity(guardian.pid!);
 writeFileSync(join(dir, ".demo-guardian"), guardianIdentity ?? "", { flag: "wx", mode: 0o600 });
 (guardian.stdin as import("node:net").Socket).unref();
 (guardian.stdout as import("node:net").Socket).unref();
 guardian.unref();
}
const now = Number(process.env.DEMO_NOW) || Date.now();
export type { DemoSession };
const baseSessions = writeDemoSessions(agentDir, now);
const fixtureSet = demoFixtures(dataMode, Object.values(baseSessions), [{ sessions: writeContentSessions(agentDir, now, dataMode) }]);
const keepSessions = new Set(fixtureSet.sessions.map((session) => session.file));
export const sessions = baseSessions;
// UI journeys must not wait through automatic cadence after fixture appends. Trigger tests verify that policy.
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ampi_arc: { auto: false, model: "synthetic/model" } }));

const agent = (pane: string, ws: string, tab: string, s: DemoSession, status = "idle", title = "") => ({
	pane_id: pane,
	workspace_id: ws,
	tab_id: tab,
	name: pane,
	terminal_title_stripped: title,
	cwd: s.cwd,
	agent_status: status,
	focused: false,
	agent: "pi",
	agent_session: { kind: "path", agent: "pi", value: s.file },
});
const s = sessions;
writeFileSync(
	join(dir, "state.json"),
	JSON.stringify({
		sessionsDir: join(agentDir, "sessions", "--work-new--"),
		workspaces: [
			{ workspace_id: "w1", label: "hypercarrier" },
			{ workspace_id: "w2", label: "personal" },
			{ workspace_id: "w3", label: "infra" },
		],
		tabs: [
			{ tab_id: "w1:t1", workspace_id: "w1", label: "reader team" },
			{ tab_id: "w1:t2", workspace_id: "w1", label: "rarebit" },
			{ tab_id: "w2:t3", workspace_id: "w2", label: "dotfiles" },
			{ tab_id: "w3:t4", workspace_id: "w3", label: "deploy" },
		],
		agents: [
			agent("w1:p1", "w1", "w1:t1", s.lead, "working", "π lead · reader team"),
			agent("w1:p2", "w1", "w1:t1", s.reader, "working", "π reader"),
			agent("w1:p3", "w1", "w1:t1", s.gui, "idle", "π gui"),
			agent("w1:p4", "w1", "w1:t2", s.big, "idle", "π long rarebit run"),
			agent("w2:p5", "w2", "w2:t3", s.solo, "blocked", "π dotfiles"),
			agent("w2:p6", "w2", "w2:t3", s.long, "idle", "π Benachrichtigungseinstellungen überarbeiten und die Übersetzungen für 日本語 prüfen"),
			agent("w3:p7", "w3", "w3:t4", s.ops, "working", "π deploy lead"),
			agent("w3:p8", "w3", "w3:t4", s.opsWorker, "working", "π deploy worker"),
		].filter((row) => keepSessions.has(row.agent_session.value)),
	}),
);
mkdirSync(join(agentDir, "sessions", "--work-new--"), { recursive: true });
const herdr = join(dir, "herdr");
writeFileSync(herdr, FAKE_HERDR);
chmodSync(herdr, 0o755);

const membership = (pane: string, sess: DemoSession, team: string, member: string, role: "lead" | "teammate") => ({
	membershipId: `m-${team}-${member}`,
	teamName: team,
	memberName: member,
	coordinationRole: role,
	lifecycle: { state: "current" },
	terminalTarget: { backend: "herdr", kind: "pane", targetId: pane },
	session: { kind: "pi-jsonl-path", locator: sess.file },
	issues: [],
});
const observation = {
	schema: "pi-teams-observation/1",
	generatedAt: new Date(now).toISOString(),
	producerVersion: "demo",
	availability: "available",
	issues: [],
	teams: [
		{ teamName: "reader", issues: [], memberships: [membership("w1:p1", s.lead, "reader", "lead", "lead"), membership("w1:p2", s.reader, "reader", "reader", "teammate"), membership("w1:p3", s.gui, "reader", "gui", "teammate")] },
		{ teamName: "deploy", issues: [], memberships: [membership("w3:p7", s.ops, "deploy", "lead", "lead"), membership("w3:p8", s.opsWorker, "deploy", "worker", "teammate")] },
	],
};

const ptb = join(dir, "observation.mjs");
// Editable synthetic Team authority: a browser check can start a Team after the page loads (verify journey S).
const observationFile = join(dir, "observation.json");
writeFileSync(observationFile, JSON.stringify(observation));
writeFileSync(
	ptb,
	`import { readFileSync as readDemoObservation } from "node:fs";\nexport async function readObservationSnapshot() { return JSON.parse(readDemoObservation(${JSON.stringify(observationFile)}, "utf8")); }\n` + DEMO_EXTENSIONS.map((extend) => extend({ dir, agentDir, now, sessions, dataMode, contentArcAnswer: contentArcSeed(dataMode) })).join("\n"),
);

if (dataMode === "empty" || dataMode === "one") pruneDemoSessions(agentDir, keepSessions);

// DEMO_HUB_TOKEN lets a test restart the demo hub with another key (a stale login cookie).
const token = process.env.DEMO_HUB_TOKEN ?? "d".repeat(64);
const hub = new Hub(
	{
		hosts: [
			{
				id: "devbox",
				label: "devbox",
				kind: "pi-local",
				cacheDir: join(dir, "cache"),
				// A test that seeds Sessions dated at a fixed past instant widens the Session scope, so its fixture does not age out.
				...(process.env.AMPI_DEMO_RECENT_MS ? { recentMs: Number(process.env.AMPI_DEMO_RECENT_MS) } : {}),
				// One offline stand-in model for every view: Chief of Staff's answers JSON prompts, Rarebit's the rest.
				askCommand: [process.execPath, join(dir, "cos-model.cjs")],
				agentConfig: { agentDir, pollMs: 100, discoverMs: 1000, teams: true, teamsMs: 2000, ptbObservation: ptb },
				env: { HOME: dir, PI_BIN: join(dir, "cos-model.cjs"), HERDR_BIN: herdr, FAKE_HERDR_STATE: join(dir, "state.json"), FAKE_HERDR_LOG: join(dir, "calls.jsonl") },
			},
		],
		// Helper models have no built-in default; the offline stand-in answers whatever they name.
		models: { rarebitAsk: "anthropic/claude-sonnet-5-5" },
	},
	{ token },
);
let closing: Promise<void> | undefined;
function close() {
 return closing ??= (async () => {
  await hub.close();
  if (process.env.DEMO_CLOSE_FAILURE === "1") throw new Error("Synthetic demo close failure");
  // This disposable Host owns its service. Stop after link shutdown so it cannot restart.
  const stopped = await maintainHost(hub.config.hosts[0]!, { op: "stop", timeoutMs: 5000 });
  if (stopped.state !== "stopped") throw new Error(`Demo Arc did not stop: ${stopped.state}`);
 })();
}
let quitting: Promise<void> | undefined;
function quit() {
 void (quitting ??= (async () => {
  let failure: unknown;
  try { await close(); } catch (error) { failure = error; }
  if (guardian && guardianExit) {
   // close() quiesces links before reporting an error. A failed resident stop
   // transfers cleanup to the guardian; a successful stop needs only its exit.
   guardian.ref();
   guardian.stdin!.end(failure ? "failed\n" : "closed\n");
   let deadline: ReturnType<typeof setTimeout> | undefined;
   try {
    await Promise.race([guardianExit, new Promise<never>((_, reject) => {
     deadline = setTimeout(() => {
      let action = "No signal was sent because the guardian generation changed or signalling failed.";
      if (ownerAlive(guardianIdentity)) {
       try { process.kill(-guardian!.pid!, "SIGKILL"); action = "Sent SIGKILL to its process group."; } catch {}
      }
      reject(new Error(`Demo guardian (pid ${guardian!.pid}) did not exit within 15 seconds. ${action} The demo Arc service for ${join(agentDir, "ampi-arc")} may still run.`));
     }, 15_000);
    })]);
   } finally { if (deadline) clearTimeout(deadline); }
  }
  if (failure) throw failure;
 })()).then(() => process.exit(0), error => { guardian?.stdin?.end(); console.error(error); process.exit(1); });
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, quit);
if (!manualLifetime) {
 const alive = () => ownerAlive(ownerIdentity) && (!runnerIdentity || ownerAlive(runnerIdentity));
 // Direct fixture launchers supply a pipe. Ad-hoc drivers use generation-checked parent polling.
 if (process.env.DEMO_OWNER_FD === "3") {
  const owner = createReadStream("", { fd: 3, autoClose: false });
  owner.on("end", quit).on("error", quit).resume();
 }
 if (!alive()) { await close(); process.exit(0); }
}
try {
 const port = await hub.listen(Number(process.env.PORT ?? 7880));
 console.log(`demo hub: http://127.0.0.1:${port}/?k=${token}  (data: ${dir}; fixture: ${dataMode})`);
 // Arc consumers wait for their own receipt. A model or resident failure must not stop the demo hub.
 void seedDemoArcs(port, token, fixtureSet.sessions.map(s => `pi:${s.id}`))
  .catch(error => { if (!closing) console.error(error); });
} catch (error) { await close(); throw error; }
