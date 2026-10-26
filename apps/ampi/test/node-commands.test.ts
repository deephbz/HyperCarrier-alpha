import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CommandsDoc } from "../src/node/commands.ts";
import { runDaemon } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const code = (expected: string) => (error: { code?: string }) => error.code === expected;

test("commands: the list, typed built-ins, skill and template expansion, refusals, and keyed replies", async () => {
	const home = tempHome();
	const agentDir = join(home, "agent");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// Project resources in `cwd/.pi` load only for a trusted project, as in Pi.
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	mkdirSync(join(home, ".pi", "prompts"), { recursive: true });
	writeFileSync(join(home, ".pi", "prompts", "review.md"), "---\ndescription: Review a file\n---\nReview $1 carefully.\n");
	const skillDir = join(home, ".pi", "skills", "probe");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "---\nname: probe\ndescription: Probe things\n---\nProbe body.\n");
	const daemon = await runDaemon({ home, simTokensPerSecond: 200 });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { requestId: "cmd-a", cwd: home, model: SIM, place: { workspace: "new", label: "Work" } });
		const view = client.sub({ kind: "thread", threadId });

		const list = await client.req("thread.commands", { threadId });
		const by = (name: string) => list.commands.find((c: any) => c.name === name);
		assert.deepEqual(["model", "thinking", "name", "compact"].map((n) => [by(n).source, by(n).supported]), Array(4).fill(["builtin", true]));
		assert.deepEqual([by("reload").supported, by("review").source, by("skill:probe").source], [false, "prompt", "skill"]);
		assert.equal(list.model, "ampi-sim/sim-1");
		assert.ok(list.models.some((m: any) => m.ref === "ampi-sim/sim-1"));
		assert.deepEqual(list.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh"]);

		const model = await client.req("thread.command", { threadId, name: "model", args: "sim-1" });
		assert.deepEqual([model.via, model.disposition, model.effect], ["node", "handled", { model: "ampi-sim/sim-1" }], "a unique bare ID selects the model");
		await assert.rejects(client.req("thread.command", { threadId, name: "model", args: "nope/none" }), code("bad_args"));
		const thinking = await client.req("thread.command", { threadId, name: "thinking", args: "high" });
		assert.deepEqual(thinking.effect, { thinking: "high", requested: "high", changed: true });
		const named = await client.req("thread.command", { threadId, name: "name", args: "Probe run", key: "n1" });
		assert.deepEqual(named.effect, { name: "Probe run" });
		const thread = await daemon.runtime.thread(threadId);
		await thread.store.harness.commit(async (tx) => {
			const record = (await tx.doc(CommandsDoc, thread.conversation.id)).keys.n1!;
			record.reply = { ...record.reply!, panel: "rarebit", body: "Saved result" };
		}, BACKGROUND_CONTEXT);
		const replay = await client.req("thread.command", { threadId, name: "name", args: "Probe run", key: "n1" });
		assert.equal(replay.panel, undefined, "a stored command reply never repeats navigation");
		assert.equal(replay.body, "Saved result", "replay retains the operation result");
		await client.until<any>(threads, (v) => v.threads[threadId]?.title === "Probe run");

		const skill = await client.req("thread.command", { threadId, name: "skill:probe", args: "now", key: "s1" });
		assert.deepEqual([skill.disposition, skill.evidence], ["started", "started"]);
		const skillText = `<skill name="probe" location="${join(skillDir, "SKILL.md")}">\nReferences are relative to ${skillDir}.\n\nProbe body.\n</skill>\n\nnow`;
		await client.until<any>(view, (v) => v.entries?.some((e: any) => e.kind === "user" && e.text === skillText));
		assert.deepEqual(await client.req("thread.command", { threadId, name: "skill:probe", args: "now", key: "s1" }), skill, "a retried key returns the first reply");
		const template = await client.req("thread.command", { threadId, name: "review", args: "a.ts b.ts", whenBusy: "followUp" });
		assert.equal(template.disposition, "queued", "a template behind a running turn queues");
		await client.until<any>(view, (v) => v.entries?.some((e: any) => e.kind === "user" && e.text === "Review a.ts carefully."));
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].queued === 0);

		await assert.rejects(client.req("thread.command", { threadId, name: "reload" }), code("unsupported_command"));
		await assert.rejects(client.req("thread.command", { threadId, name: "missing" }), code("unknown_command"));
		const compact = await client.req("thread.command", { threadId, name: "compact", key: "c1" });
		assert.deepEqual([compact.disposition, compact.evidence], ["handled", "compaction_started"]);
		assert.deepEqual(await client.req("thread.command", { threadId, name: "compact", key: "c1" }), compact);

		// Pi clamps the level to the model: a model without reasoning has only "off".
		const plain = daemon.runtime.models.getModels().find((m) => !m.reasoning)!;
		await client.req("thread.configure", { threadId, model: { provider: plain.provider, modelId: plain.id } });
		const clamped = await client.req("thread.command", { threadId, name: "thinking", args: "high" });
		assert.deepEqual(clamped.effect, { thinking: "off", requested: "high", changed: true });
		assert.match(clamped.notice, /not available/);
		client.close();
	} finally {
		await daemon.stop();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});
