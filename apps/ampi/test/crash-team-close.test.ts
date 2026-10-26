import "./bound.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseThreadKey } from "../src/node/runtime.ts";
import { CrashChild } from "./durable-l2/process.ts";
import { tempHome } from "./helpers.ts";

const fixture = new URL("./durable-l4/integration-pending-node.ts", import.meta.url);

for (const lifecycle of ["close", "archive"] as const) test(`${lifecycle} recovery stops the Team after a kill before plugin intents; a second reopen changes nothing`, async () => {
	const dir = tempHome(), children: CrashChild[] = [];
	let sequence = 0;
	const start = async (mode: string) => {
		const child = new CrashChild(dir, "close-team", mode, fixture);
		children.push(child);
		// The bound detects a hang, not speed: a hosted Linux runner starts the node in over 2 s.
		await child.wait("ready", undefined, 10_000);
		return child;
	};
	const command = async (child: CrashChild, command: string) => {
		const name = String(++sequence);
		child.child.send({ command, name });
		return (await child.wait(command, name, 2000)).value;
	};
	const kill = async (child: CrashChild) => {
		child.child.kill("SIGKILL");
		assert.equal((await child.exited).signal, "SIGKILL");
	};
	const ledger = (mode: string): any[] => {
		const path = join(dir, `${mode}-ledger.jsonl`);
		return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
	};
	try {
		const seed = await start("seed");
		seed.child.send({ command: "seed" });
		const { ids, before } = (await seed.wait("seeded", undefined, 2000)).value;
		assert.equal(ids.pending.length, 2, "both deliveries reached the pre-submit barrier");
		assert.equal(before.team.current.lifecycle, "active");
		if (lifecycle === "close") assert.equal((await command(seed, "close-intent")).evidence, "closed");
		else assert.deepEqual(await command(seed, "archive-intent"), {}, "Archive commits its mark while Team work is pending");
		assert.equal((await command(seed, "snapshot")).team.current.lifecycle, "active", `the fault precedes the plugin ${lifecycle} intent`);
		await kill(seed);

		const store = parseThreadKey(ids.lead).storeId;
		let prior: any;
		for (const mode of ["reopen", "reopen-again"]) {
			const child = await start(mode);
			let snapshot: any;
			const deadline = Date.now() + 1500;
			do {
				snapshot = await command(child, "snapshot");
				if ((!snapshot.inspection.tasks.length && snapshot.team.current.lifecycle === "stopped") || Date.now() >= deadline) break;
				await new Promise(resolve => setTimeout(resolve, 10));
			} while (true);
			assert.equal(snapshot.inspection.tasks.length, 0, "closed native work settles promptly");
			assert.equal(snapshot.team.current.lifecycle, "stopped", "native cancellation must also finish the Team stop");
			assert.deepEqual(Object.values(snapshot.team.current.workers).map((w: any) => w.state), ["stopped", "stopped"]);
			assert.ok(Object.values(snapshot.team.stops).every((stop: any) => stop.confirmed));
			assert.ok(Object.values(snapshot.outbox.obligations).every((o: any) => o.state === "retired"));
			assert.ok(snapshot.admissions.every((a: any) => a.submission == null), "Close admits no held delivery");
			assert.ok(snapshot.deliveryTasks.every((t: any) => t.state.status === "terminal"));
			assert.deepEqual(snapshot.taskIds, before.taskIds, "Close recovery creates no new runnable work");
			const events = ledger(mode).filter(e => e.store === store);
			assert.deepEqual(events.filter(e => ["model", "tool", "compact"].includes(e.kind)), [], "recovery starts no model or tool");
			assert.deepEqual(ledger(mode).filter(e => e.kind === "delivery-submit"), []);
			const state = { team: snapshot.team, outbox: snapshot.outbox, entries: snapshot.workerEntries, journal: snapshot.journal, tasks: snapshot.deliveryTasks };
			if (prior) assert.deepEqual(state, prior, "a second reopen preserves the same completed stop");
			else {
				const marks = events.slice(0, events.findIndex(e => e.kind === "scheduler-start")).filter(e => e.kind === "mark");
				assert.equal(marks.length, 4, `${lifecycle}, both Workers, and mechanics are marked before resume`);
				prior = state;
			}
			await kill(child);
		}
	} finally {
		for (const child of children) child.cleanup();
		await Promise.all(children.map(child => child.exited));
		rmSync(dir, { recursive: true, force: true });
	}
});
