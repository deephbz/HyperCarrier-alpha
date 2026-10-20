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

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub/hub.ts";
import { FAKE_HERDR } from "../test/pi-fixtures.ts";
import { DEMO_EXTENSIONS } from "./demo/index.ts";

const dir = process.env.DEMO_DIR ?? join(tmpdir(), "ampi-pi-demo");
if (process.env.DEMO_KEEP !== "1") rmSync(dir, { recursive: true, force: true });
const agentDir = join(dir, "agent");
const now = Number(process.env.DEMO_NOW) || Date.now();
const HOUR = 3600_000;
const L = (o: unknown) => `${JSON.stringify(o)}\n`;
let seq = 0;
let rnd = 7;
const random = () => ((rnd = (rnd * 16807) % 2147483647) - 1) / 2147483646;

export type DemoSession = { name: string; file: string; id: string; cwd: string };

type Plan = {
	name: string;
	cwd: string;
	/** Start, hours before now. */
	startH: number;
	/** Turns; each turn is a user message, an assistant tool call, a tool result, and a closing assistant message. */
	turns: number;
	/** Minutes between turns (jittered). */
	gapMin?: number;
	/** Compact after these turn indexes. */
	compactAt?: number[];
	/** The last turn ends in a terminal error. */
	errorAtEnd?: boolean;
	/** Cost scale per turn, in dollars. */
	costPerTurn?: number;
	first?: string;
	model?: string;
};

function write(plan: Plan): DemoSession {
	const sdir = join(agentDir, "sessions", `--${plan.cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
	mkdirSync(sdir, { recursive: true });
	const id = `sess-${plan.name}`;
	const file = join(sdir, `${plan.name}.jsonl`);
	let t = now - plan.startH * HOUR;
	const iso = () => new Date(t).toISOString();
	let out = L({ type: "session", version: 3, id, timestamp: iso(), cwd: plan.cwd });
	let parent: string | null = null;
	const model = plan.model ?? "claude-opus-5-5";
	const cost = plan.costPerTurn ?? 0.02;
	for (let i = 0; i < plan.turns; i++) {
		const u = `u${++seq}`;
		const a = `a${++seq}`;
		const r = `r${++seq}`;
		const a2 = `a${++seq}`;
		const call = `c${seq}`;
		const scale = 0.4 + random() * 1.6;
		const text = i === 0 ? (plan.first ?? `Please work on ${plan.name}.`) : `Continue with step ${i}. Check the tests and summarize what changed.`;
		out += L({ type: "message", id: u, parentId: parent, timestamp: iso(), message: { role: "user", content: [{ type: "text", text }], timestamp: t } });
		t += 20_000;
		const usage = (k: number) => ({ input: Math.round(1200 * scale * k), output: Math.round(300 * scale * k), cacheRead: Math.round(9000 * scale), cacheWrite: 0, cost: { total: +(cost * scale * k * 0.5).toFixed(4) } });
		out += L({
			type: "message",
			id: a,
			parentId: u,
			timestamp: iso(),
			message: {
				role: "assistant",
				model,
				provider: "anthropic",
				stopReason: "toolUse",
				usage: usage(1),
				content: [
					{ type: "thinking", thinking: "Let me look at the files first." },
					{ type: "text", text: `Looking at **step ${i}**. I'll list the files and run the tests.` },
					{ type: "toolCall", id: call, name: "bash", arguments: { command: "ls src && npm test" } },
				],
			},
		});
		t += 15_000;
		out += L({ type: "message", id: r, parentId: a, timestamp: iso(), message: { role: "toolResult", toolCallId: call, toolName: "bash", content: [{ type: "text", text: "index.ts\nreader.ts\n\n✔ 42 tests passed" }], isError: false } });
		t += 25_000;
		const last = i === plan.turns - 1;
		const failed = last && plan.errorAtEnd;
		out += L({
			type: "message",
			id: a2,
			parentId: r,
			timestamp: iso(),
			message: {
				role: "assistant",
				model,
				provider: "anthropic",
				stopReason: failed ? "error" : "stop",
				...(failed ? { errorMessage: "529 overloaded: the provider is temporarily unavailable" } : {}),
				usage: usage(1),
				content: failed ? [] : [{ type: "text", text: `Step ${i} done.\n\n- Tests pass (42)\n- Changed \`reader.ts\`\n\n\`\`\`ts\nexport const x = ${i};\n\`\`\`` }],
			},
		});
		parent = a2;
		if (plan.compactAt?.includes(i)) {
			const c = `k${++seq}`;
			t += 30_000;
			out += L({ type: "compaction", id: c, parentId: parent, timestamp: iso(), summary: `## Goal\nFinish ${plan.name}.\n\n## Progress\nSteps 0–${i} done; tests pass.`, firstKeptEntryId: parent, tokensBefore: 180_000 });
			parent = c;
		}
		t += (plan.gapMin ?? 3) * 60_000 * (0.3 + random() * 1.4);
	}
	writeFileSync(file, out);
	return { name: plan.name, file, id, cwd: plan.cwd };
}

export const sessions = {
	lead: write({ name: "lead", cwd: "/work/hypercarrier", startH: 30, turns: 60, gapMin: 25, compactAt: [30], first: "Lead the reader Team: Host-qualified records and the GUI sidebar." }),
	reader: write({ name: "worker-reader", cwd: "/work/hypercarrier", startH: 28, turns: 40, gapMin: 30, costPerTurn: 0.01, model: "claude-sonnet-5-5" }),
	gui: write({ name: "worker-gui", cwd: "/work/hypercarrier", startH: 27, turns: 45, gapMin: 28, costPerTurn: 0.01, model: "claude-sonnet-5-5" }),
	big: write({ name: "big", cwd: "/work/rarebit", startH: 70, turns: 600, gapMin: 6, compactAt: [150, 320, 480], first: "A very long Session: keep the Rarebit selector honest across compactions." }),
	solo: write({ name: "solo", cwd: "/work/dotfiles", startH: 5, turns: 6, gapMin: 20, errorAtEnd: true, first: "Update the ssh config for the new devbox." }),
	ops: write({ name: "ops-lead", cwd: "/work/infra", startH: 12, turns: 25, gapMin: 20, costPerTurn: 0.05, first: "Lead the deploy Team: roll the hub to the second Host." }),
	opsWorker: write({ name: "ops-worker", cwd: "/work/infra", startH: 11, turns: 18, gapMin: 22, costPerTurn: 0.03 }),
	long: write({ name: "long-title", cwd: "/work/an/unusually/deep/directory/structure/for-a-project-with-a-long-name", startH: 2, turns: 4, first: "Benachrichtigungseinstellungen überarbeiten und die Übersetzungen für 日本語 prüfen" }),
	loose: write({ name: "loose", cwd: "/work/scratch", startH: 8, turns: 3, first: "A Session run outside Herdr, in plain tmux." }),
};

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
	`import { readFileSync as readDemoObservation } from "node:fs";\nexport async function readObservationSnapshot() { return JSON.parse(readDemoObservation(${JSON.stringify(observationFile)}, "utf8")); }\n` + DEMO_EXTENSIONS.map((extend) => extend({ dir, agentDir, sessions })).join("\n"),
);

const token = "d".repeat(64);
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
		backend: "pi",
		// Helper models have no built-in default; the offline stand-in answers whatever they name.
		models: { arcLabels: "anthropic/claude-haiku-5-5", arcSynthesis: "anthropic/claude-sonnet-5-5", rarebitRecap: "anthropic/claude-haiku-5-5", rarebitAsk: "anthropic/claude-sonnet-5-5" },
	},
	{ token },
);
const port = await hub.listen(Number(process.env.PORT ?? 7880));
console.log(`demo hub: http://127.0.0.1:${port}/?k=${token}  (data: ${dir})`);
