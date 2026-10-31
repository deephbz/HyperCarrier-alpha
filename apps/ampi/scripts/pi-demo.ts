// A demo hub for building and screenshotting the one GUI without a real Host (docs/one-gui-views.md, "Demo").
// One Pi Host on this machine, fed by a fake Herdr, a fake Pi Team Bright observation module, and synthetic Pi
// Sessions spread over three days: two Teams, a 600-turn Session, compactions, a terminal error, long and non-Latin
// titles, a Session outside Herdr, and a pane waiting for input. Everything is synthetic; nothing reads real logs.
//
//   node apps/ampi/scripts/pi-demo.ts            # http://127.0.0.1:7880/?k=<64 × d>, data under $TMPDIR/ampi-pi-demo
//   PORT=7881 DEMO_DIR=/tmp/x node apps/ampi/scripts/pi-demo.ts
//   DEMO_KEEP=1 DEMO_NOW=<epoch ms> ...      # a restart: keep the hub state; the base Sessions are rewritten byte-identical
//
// Views extend the data through scripts/demo/index.ts (one function per view), not by editing the base Sessions.

import "./stdio-sync.cjs";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "../src/hub/hub.ts";
import { FAKE_HERDR } from "../test/pi-fixtures.ts";
import { DEMO_EXTENSIONS } from "./demo/index.ts";
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

const dir = process.env.DEMO_DIR ?? join(tmpdir(), "ampi-pi-demo");
if (process.env.DEMO_KEEP !== "1") rmSync(dir, { recursive: true, force: true });
const agentDir = join(dir, "agent");
const now = Number(process.env.DEMO_NOW) || Date.now();
export type { DemoSession };
export const sessions = writeDemoSessions(agentDir, now);

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
		],
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
	`import { readFileSync as readDemoObservation } from "node:fs";\nexport async function readObservationSnapshot() { return JSON.parse(readDemoObservation(${JSON.stringify(observationFile)}, "utf8")); }\n` + DEMO_EXTENSIONS.map((extend) => extend({ dir, agentDir, now, sessions })).join("\n"),
);

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
				// One offline stand-in model for every view: Chief of Staff's answers JSON prompts, Rarebit's the rest.
				askCommand: [process.execPath, join(dir, "cos-model.cjs")],
				agentConfig: { agentDir, pollMs: 100, discoverMs: 1000, teams: true, teamsMs: 2000, ptbObservation: ptb },
				env: { HOME: dir, HERDR_BIN: herdr, FAKE_HERDR_STATE: join(dir, "state.json"), FAKE_HERDR_LOG: join(dir, "calls.jsonl") },
			},
		],
		// Helper models have no built-in default; the offline stand-in answers whatever they name.
		models: { arcLabels: "anthropic/claude-haiku-5-5", arcSynthesis: "anthropic/claude-sonnet-5-5", rarebitAsk: "anthropic/claude-sonnet-5-5" },
	},
	{ token },
);
const port = await hub.listen(Number(process.env.PORT ?? 7880));
console.log(`demo hub: http://127.0.0.1:${port}/?k=${token}  (data: ${dir})`);
