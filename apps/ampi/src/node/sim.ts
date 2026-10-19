// "ampi-sim": a deterministic, offline model for demos and end-to-end tests. It streams like a real provider (pi-ai's
// faux core) and follows small directives in the user's text, so every AmPi surface (tools, diffs, Team, Rarebit,
// compaction) can be exercised without network access or credentials. It is a test double, not a product model.

import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

type Step = { tool: string; args: ToolCall["arguments"] } | ((results: ToolOutcome[]) => Step | undefined);
type ToolOutcome = { name: string; text: string; isError: boolean };
type Plan = { steps: Step[]; think: boolean; final?: (results: ToolOutcome[]) => string; error?: string };

export const SIM_PROVIDER = "ampi-sim";
export const SIM_MODEL = "sim-1";

function text(message: Message): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: { type: string }) => part.type === "text")
		.map((part: { text?: string }) => part.text ?? "")
		.join("\n");
}

function imagesIn(message: Message): string[] {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? content.filter((p: { type: string }) => p.type === "image").map((p: { mimeType?: string }) => p.mimeType ?? "image") : [];
}

function parseJson(raw: string): ToolCall["arguments"] {
	try {
		const value: unknown = JSON.parse(raw);
		return value !== null && typeof value === "object" ? (value as ToolCall["arguments"]) : {};
	} catch {
		return {};
	}
}

function findJson(texts: string, key: string): string | undefined {
	const match = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(texts);
	return match?.[1];
}

/** Builds the plan the sim follows for one user (or delivered) message. */
export function planFor(input: string): Plan {
	const steps: Step[] = [];
	let think = false;
	let error: string | undefined;
	let final: Plan["final"];
	for (const line of input.split("\n")) {
		const trimmed = line.trim();
		let m: RegExpExecArray | null;
		if ((m = /^\/sim bash (.+)$/.exec(trimmed))) steps.push({ tool: "bash", args: { command: m[1] } });
		else if ((m = /^\/sim tool (\S+)\s*(.*)$/.exec(trimmed))) steps.push({ tool: m[1], args: parseJson(m[2] || "{}") });
		else if (trimmed === "/sim think") think = true;
		else if ((m = /^\/sim error\s*(.*)$/.exec(trimmed))) error = m[1] || "Simulated provider error";
		else if ((m = /^\/sim long (\d+)$/.exec(trimmed))) {
			const n = Number(m[1]);
			final = () =>
				Array.from(
					{ length: n },
					(_, i) =>
						`Paragraph ${i + 1}. ${"The simulated model writes a long, detailed answer so that the context grows. ".repeat(12)}`,
				).join("\n\n");
		}
	}
	// A delivered Team task: claim it, do visible work, then report the outcome with evidence (PTB worker contract).
	const task = /AMPI-TEAM-TASK task_id=(\S+) version=(\S+)/.exec(input);
	if (task) {
		const [, taskId, version] = task;
		const fail = /goal: .*\bfail\b/i.test(input);
		steps.push({ tool: "task_update", args: { task_id: taskId, expected_version: version, transition: "claim" } });
		steps.push({ tool: "bash", args: { command: `echo "worker evidence for ${taskId}: $(date -u +%H:%M:%S)"` } });
		steps.push((results) => {
			const claimed = results.find((r) => r.name === "task_update");
			const next = claimed ? findJson(claimed.text, "version") : undefined;
			if (next === undefined) return undefined;
			return {
				tool: "task_update",
				args: {
					task_id: taskId,
					expected_version: next,
					transition: fail ? "goal_failed" : "goal_achieved",
					evidence: results.find((r) => r.name === "bash")?.text.trim() ?? "no output",
				},
			};
		});
		final = (results) => `Task \`${taskId}\` ${fail ? "failed its goal" : "achieved its goal"}. Evidence:\n\n\`\`\`\n${results.find((r) => r.name === "bash")?.text.trim() ?? ""}\n\`\`\``;
	}
	if (/^\/sim team\b/m.test(input)) {
		const purpose = /^\/sim team\s*(.*)$/m.exec(input)?.[1] || "Demo team";
		steps.push({ tool: "team_create", args: { name: "demo", purpose } });
		steps.push({ tool: "ensure_worker", args: { name: "alice", scope: "Backend changes and tests" } });
		steps.push({ tool: "ensure_worker", args: { name: "bob", scope: "Docs and release notes" } });
		steps.push({
			tool: "task_graph_apply",
			args: {
				operation_id: "plan-1",
				tasks: [
					{ key: "api", title: "Add the API endpoint", goal: "Endpoint returns 200 with a test", assignee: "alice" },
					{ key: "docs", title: "Document the endpoint", goal: "README section exists", assignee: "bob", needs: ["api"] },
					{ key: "release", title: "Write release notes", goal: "Notes mention the endpoint", assignee: "bob", needs: ["docs"] },
				],
			},
		});
		final = () => "Team **demo** is running: alice owns `api`; bob owns `docs` and `release` after it. I'll wait for updates.";
	}
	if (/AMPI-TEAM-UPDATE/.test(input)) {
		steps.push({ tool: "team_sync", args: { view: "snapshot" } });
		final = (results) => {
			const snapshot = results[0]?.text ?? "";
			const done = (snapshot.match(/goal_achieved/g) ?? []).length;
			return `Team update received. ${done} task(s) have achieved their goal so far.`;
		};
	}
	return { steps, think, final, error };
}

function answerFor(input: string): string {
	const first = input.split("\n")[0]?.slice(0, 200) ?? "";
	return [
		`**ampi-sim** received your message: _${first.replace(/[_*]/g, "")}_`,
		"",
		"This simulated model runs offline. It can:",
		"",
		"- run a command: `/sim bash ls -la`",
		"- call any tool: `/sim tool read {\"path\":\"README.md\"}`",
		"- start a demo Team: `/sim team Ship the endpoint`",
		"- write a long answer to grow the context: `/sim long 40`",
		"",
		"```ts",
		"const answer = await thread.submit(\"hello\");",
		"```",
	].join("\n");
}

/** One-shot derivation prompts (Rarebit Summary and Title) get deterministic, contract-shaped answers. */
function derivation(prompt: string): string | undefined {
	if (prompt.startsWith("You are the HyperCarrier Rarebit summarizer.")) {
		const body = /BEGIN_RAREBIT_MESSAGES_JSONL\n([\s\S]*?)\nEND_RAREBIT_MESSAGES_JSONL/.exec(prompt)?.[1] ?? "";
		const messages = body
			.split("\n")
			.map((line) => parseJson(line) as { role?: string; outcome?: string; text?: string })
			.filter((m) => typeof m.text === "string");
		const users = messages.filter((m) => m.role === "user");
		const last = messages.at(-1);
		const request = (users.at(-1)?.text ?? "").replace(/^\/sim .*$/gm, "").trim().replace(/\s+/g, " ").slice(0, 140);
		const asks = /\?\s*$|needs? (your|a) decision|\/sim attention/i.test(last?.text ?? "") || /\/sim attention/.test(users.at(-1)?.text ?? "");
		return JSON.stringify(
			asks
				? { summary: `The agent is waiting on the owner. Latest request: ${request || "(directive only)"}. ${users.length} user message(s) so far.`, sessionStatus: "needs_attention", statusReason: "input" }
				: { summary: `${users.length} user request(s); the latest (${request || "a directive"}) appears answered by the final handoff.`, sessionStatus: "finished", statusReason: "all_requests_accomplished" },
		);
	}
	if (prompt.startsWith("You are compacting a coding-agent conversation.")) {
		const users = [...prompt.matchAll(/\[User\]\n([^\n]*)/g)].map((m) => m[1]!.trim()).filter(Boolean);
		return [
			"## Goal",
			`- ${users[0] ?? "(unknown)"}`,
			"## Done",
			...users.slice(0, -1).map((u) => `- [x] ${u.slice(0, 120)}`),
			"## In progress",
			`- [ ] ${users.at(-1)?.slice(0, 120) ?? "(nothing)"}`,
			"## Next steps",
			"1. Continue from the latest request (simulated working-state summary).",
		].join("\n");
	}
	if (prompt.startsWith("Propose a short, specific title")) {
		const initial = parseJson(prompt.slice(prompt.indexOf("{"))).initialUserMessage;
		const words = String(initial ?? "").replace(/^\/sim\s+\S+/gm, "").replace(/[`*#]/g, "").trim().split(/\s+/).filter(Boolean);
		return words.length ? words.slice(0, 7).join(" ") : "Simulator session";
	}
	return undefined;
}

function respond(messages: readonly Message[]): AssistantMessage {
	const first = messages.find((m) => m.role === "user");
	const prompt = messages.length === 1 && first ? text(first) : "";
	if (prompt.startsWith("You are compacting") && prompt.includes("/sim compact-error"))
		return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Simulated summarizer outage" });
	const oneShot = prompt ? derivation(prompt) : undefined;
	// Durable's native compaction summarizer (system prompt + one request): answer with a plain summary, never directives.
	if (messages[0]?.role === ("system" as never) && /summariz/i.test(text(messages[0]!)))
		return fauxAssistantMessage([fauxText("## Goal\n- (native summary from the simulated model)\n## Next Steps\n1. Continue.")], { stopReason: "stop" });
	if (oneShot !== undefined) return fauxAssistantMessage([fauxText(oneShot)], { stopReason: "stop" });
	let runStart = messages.length - 1;
	while (runStart >= 0 && messages[runStart]!.role !== "user") runStart--;
	const user = runStart >= 0 ? text(messages[runStart]!) : "";
	const plan = planFor(user);
	const results: ToolOutcome[] = [];
	let turns = 0;
	for (let i = runStart + 1; i < messages.length; i++) {
		const message = messages[i]! as Message & { toolName?: string; isError?: boolean };
		if (message.role === "assistant") turns++;
		if (message.role === "toolResult")
			results.push({ name: message.toolName ?? "", text: text(message), isError: message.isError === true });
	}
	if (plan.error !== undefined) return fauxAssistantMessage([], { stopReason: "error", errorMessage: plan.error });
	if (turns < plan.steps.length) {
		let step = plan.steps[turns]!;
		if (typeof step === "function") step = step(results) ?? { tool: "", args: {} };
		if (typeof step !== "function" && step.tool !== "") {
			const blocks = [];
			if (plan.think && turns === 0) blocks.push(fauxThinking("Planning the tool calls for this request."));
			blocks.push(fauxToolCall(step.tool, step.args));
			return fauxAssistantMessage(blocks, { stopReason: "toolUse" });
		}
	}
	const blocks = [];
	if (plan.think) blocks.push(fauxThinking("Summarizing what happened."));
	let answer: string;
	if (plan.final) answer = plan.final(results);
	else if (results.length > 0)
		answer = results
			.map((r) => `\`${r.name}\` ${r.isError ? "failed" : "returned"}:\n\n\`\`\`\n${r.text.slice(0, 2000).trim()}\n\`\`\``)
			.join("\n\n");
	else answer = answerFor(user);
	const images = runStart >= 0 ? imagesIn(messages[runStart]!) : [];
	if (images.length) answer = `I received ${images.length} image${images.length === 1 ? "" : "s"} (${images.join(", ")}).\n\n${answer}`;
	blocks.push(fauxText(answer));
	return fauxAssistantMessage(blocks, { stopReason: "stop" });
}

/** The sim provider; `tokensPerSecond` paces streaming so UIs show partials. */
export function simProvider(options: { tokensPerSecond?: number; contextWindow?: number } = {}) {
	const handle = fauxProvider({
		provider: SIM_PROVIDER,
		api: "ampi-sim",
		tokensPerSecond: options.tokensPerSecond ?? 600,
		models: [
			{
				id: SIM_MODEL,
				name: "Simulated model (offline)",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: options.contextWindow ?? 64_000,
				maxTokens: 8_000,
			},
		],
	});
	const step = (context: { messages: readonly Message[] }) => {
		handle.appendResponses([step]);
		return respond(context.messages);
	};
	// Keep a deep queue so concurrent requests (parallel workers) never find it empty; each call refills one.
	handle.setResponses(Array.from({ length: 256 }, () => step));
	return handle.provider;
}
