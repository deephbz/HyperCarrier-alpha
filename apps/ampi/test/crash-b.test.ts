import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { socketPath } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";
import { BIN, SIM, startNode, kill } from "./crash-fixtures.ts";

test("crash: a node killed mid-delivery delivers every Team notice exactly once after restart", async () => {
	const home = tempHome();
	let { child, client } = await startNode(home, 1500);
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim team Ship the endpoint" });
		let team = client.sub({ kind: "team", teamId: threadId });
		// Kill while an accepted Delivery has not settled: acceptance is committed, actuation is in flight.
		const atKill = await client.until<any>(team, (v) => v.deliveries?.some((d: any) => !d.settled), 20_000);
		await kill(child);
		({ child, client } = await startNode(home, 20000));
		team = client.sub({ kind: "team", teamId: threadId });
		const done = await client.until<any>(
			team,
			(v) => v.tasks?.length === 3 && v.tasks.every((t: any) => t.derived === "goal_achieved") && v.deliveries.every((d: any) => d.settled),
			60_000,
		);
		const taskDeliveries = done.deliveries.filter((d: any) => d.kind === "task");
		assert.equal(taskDeliveries.length, 3);
		assert.ok(atKill.deliveries.length >= 1);
		// Exactly once at the receiving end: each Worker transcript holds one notice per assigned Task.
		for (const worker of done.workers) {
			const view = client.sub({ kind: "thread", threadId: worker.threadId });
			const transcript = await client.until<any>(view, (v) => v.entries.length > 0);
			const notices = transcript.entries.filter((e: any) => e.kind === "custom" && e.entryKind === "team.notice" && /AMPI-TEAM-TASK/.test(e.text));
			const ids = notices.map((e: any) => /task_id=(\S+)/.exec(e.text)![1]);
			const assigned = done.tasks.filter((t: any) => t.assignee === worker.name).map((t: any) => t.key);
			assert.deepEqual([...ids].sort(), [...assigned].sort(), `${worker.name} got each Task notice once`);
		}
		assert.deepEqual(client.gaps, []);
		client.close();
	} finally {
		await kill(child);
	}
});
