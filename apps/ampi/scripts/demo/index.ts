// Per-view demo data for scripts/pi-demo.ts. One entry per view; each returns extra ES module source appended to the
// fake Pi Team Bright module (for example another exported read function), or "" after writing its own files.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PiTeamTask } from "../../src/pi/views/team.ts";
import { cosDemo } from "./cos.ts";

export type DemoContext = { dir: string; agentDir: string; sessions: Record<string, { name: string; file: string; id: string; cwd: string }> };

function teamDemo({ dir }: DemoContext): string {
	const task = (id: string, title: string, status: string, owner: string, deps: string[] = []): PiTeamTask => ({ id, title, status, owner, deps, ready: status === "ready" });
	const tasks = {
		reader: [
			task("R1", "Read Host-qualified Session records", "goal_achieved", "reader"),
			task("R2", "Check the reader across compactions", "ready", "reader", ["R1"]),
			task("R3", "Waiting for a decision on the sidebar contract", "blocked", "gui", ["R1"]),
			task("R4", "Render the Team panel", "in_progress", "gui", ["R1"]),
			task("R5", "Verify the sidebar after the contract is accepted", "dependency_waiting", "reader", ["R3"]),
			task("R6", "Ship the reader after sidebar verification", "dependency_waiting", "lead", ["R5", "R4"]),
			task("R7", "Check the old transport", "goal_failed", "reader"),
			task("R8", "Replace every Session ID with a pane ID", "cancelled", "lead"),
			task("R9", "Benachrichtigungseinstellungen überarbeiten und die Übersetzungen für 日本語 prüfen — preserve exact Session identity across every reconnect, compaction, and worker restart without treating runtime activity as Task completion", "ready", "gui", ["R1"]),
		],
		deploy: [task("D1", "Prepare the second Host", "goal_achieved", "worker"), task("D2", "Roll the hub to the second Host", "in_progress", "worker", ["D1"]), task("D3", "Verify the rollout", "dependency_waiting", "lead", ["D2"])],
	};
	const file = join(dir, "team-tasks.json");
	// Editable synthetic authority for browser checks: [] is empty; null is unavailable.
	writeFileSync(file, JSON.stringify(tasks));
	return `import { readFileSync as readTeamDemo } from 'node:fs';
const readBaseTeamObservation = readObservationSnapshot;
readObservationSnapshot = async () => {
  const snapshot = await readBaseTeamObservation();
  const flags = JSON.parse(readTeamDemo(${JSON.stringify(file)}, 'utf8'));
  if (flags.__availability) snapshot.availability = flags.__availability;
  return snapshot;
};
export async function readTaskSnapshot({teamName}) {
  const tasks = JSON.parse(readTeamDemo(${JSON.stringify(file)}, 'utf8'))[teamName];
  return {schema:'pi-team-tasks/1',teamName,availability:tasks === null ? 'unavailable' : 'available',tasks:tasks ?? [],issues:tasks === null ? ['task_authority_unavailable'] : []};
}`;
}

function rarebit({ sessions }: DemoContext): string {
	const line = (value: unknown) => `${JSON.stringify(value)}\n`;
	const header = (id: string) => line({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/work/demo" });
	writeFileSync(join(dirname(sessions.loose!.file), "rarebit-empty.jsonl"), header("sess-rarebit-empty"));
	writeFileSync(join(dirname(sessions.loose!.file), "rarebit-error.jsonl"), header("sess-rarebit-error") + line({ type: "message", id: "demo-u", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "A deliberately malformed synthetic Session copy, for the error state." } }) + "{malformed demo line}\n");
	return "";
}

function typographyDemo({ sessions }: DemoContext): string {
	const timestamp = new Date().toISOString();
	const rows = [
		{ type: "session", version: 3, id: "sess-typography", timestamp, cwd: "/work/synthetic" },
		{ type: "session_info", id: "font-title", parentId: null, timestamp, name: "Typography · 日本語 · Übersetzungen" },
		{ type: "message", id: "font-user", parentId: "font-title", timestamp, message: { role: "user", content: "Check the typography across prose, code, and controls." } },
		{ type: "message", id: "font-prose", parentId: "font-user", timestamp, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "# First heading\n\nA synthetic paragraph with **bold prose** and `inlineCode()` for comparison.\n\n## Second heading\n\n- A list item with readable text.\n- 日本語 · Übersetzungen\n\n### Third heading\n\n```ts\nconst typography = { body: 13, line: 20 };\n```" }] } },
	];
	writeFileSync(join(dirname(sessions.loose!.file), "typography.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	return "";
}

function lensDemo({ sessions }: DemoContext): string {
	for (const [name, count] of [["lens-runs", 7], ["lens-window", 160]] as const) {
		const start = new Date();
		start.setHours(14, 2, 0, 0);
		let parent: string | null = null;
		let sequence = 0;
		let text = `${JSON.stringify({ type: "session", version: 3, id: `sess-${name}`, timestamp: start.toISOString(), cwd: "/work/demo" })}\n`;
		const message = (offset: number, value: Record<string, unknown>) => {
			const id = `${name}-${++sequence}`;
			const ts = +start + offset;
			text += `${JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(ts).toISOString(), message: { ...value, timestamp: ts } })}\n`;
			parent = id;
		};
		const prose = (offset: number, value: string) => message(offset, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: value }] });
		message(0, { role: "user", content: [{ type: "text", text: `Verify ${name}: one timed line between prose blocks.` }] });
		for (let i = 0; i < count; i++) {
			message(i * 1500 + 1000, { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: `Inspect synthetic step ${i + 1}.` }, { type: "toolCall", id: `call-${i}`, name: "bash", arguments: { command: `echo step-${i + 1}` } }] });
			message(i * 1500 + 2000, { role: "toolResult", toolCallId: `call-${i}`, toolName: "bash", isError: i === 3, content: [{ type: "text", text: i === 3 ? "Synthetic failure: retry the step." : `Synthetic result ${i + 1}` }] });
		}
		prose(252000, "The tool run is complete. Inspect its calls on demand.");
		message(254000, { role: "assistant", content: [{ type: "thinking", thinking: "Check the result before the handoff." }] });
		prose(258000, "Thinking-only evidence also stays one click away.");
		message(260000, { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "tail", name: "read", arguments: { path: "README.md" } }] });
		writeFileSync(join(dirname(sessions.loose!.file), `${name}.jsonl`), text);
	}
	return "";
}

export const DEMO_EXTENSIONS: ((ctx: DemoContext) => string)[] = [teamDemo, rarebit, cosDemo, typographyDemo, lensDemo];
