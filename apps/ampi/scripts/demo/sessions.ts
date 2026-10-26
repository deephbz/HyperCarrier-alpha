// The base synthetic Pi Sessions of the demo hub (scripts/pi-demo.ts): two Teams, a 600-turn Session,
// compactions, a terminal error, and long and non-Latin titles. The same agentDir and now give byte-identical files,
// so a golden check (scripts/durable/derive-golden.ts) can rebuild them without a hub.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOUR = 3600_000;
const L = (o: unknown) => `${JSON.stringify(o)}\n`;

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

export function writeDemoSessions(agentDir: string, now: number) {
	let seq = 0;
	let rnd = 7;
	const random = () => ((rnd = (rnd * 16807) % 2147483647) - 1) / 2147483646;
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
	return {
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
}
