import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { socketPath } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";

export const BIN = fileURLToPath(new URL("../bin/ampi.mjs", import.meta.url));
export const SIM = { provider: "ampi-sim", modelId: "sim-1" };

/**
 * A real `ampi node` process, so the crash is a SIGKILL with no shutdown path. The node belongs to this call until it
 * answers: on failure the call kills it, because a live orphan keeps the test file running.
 */
export async function startNode(home: string, tps: number, env: Record<string, string> = {}): Promise<{ child: ChildProcess; client: TestClient }> {
	const child = spawn(process.execPath, [BIN, "node"], { env: { ...process.env, AMPI_HOME: home, AMPI_SIM_TPS: String(tps), ...env }, stdio: "ignore" });
	// Startup took over 15 s at load 285.
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			return { child, client: await TestClient.connect(socketPath(home)) };
		} catch (error) {
			const exited = child.exitCode !== null || child.signalCode !== null;
			if (exited || Date.now() > deadline) {
				await kill(child);
				throw exited ? new Error(`ampi node exited (${child.exitCode ?? child.signalCode}) before it answered on ${socketPath(home)}`) : error;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	}
}

/**
 * Kills the node each time the thread streams, until the thread shows attention instead. pi-durable counts a model
 * request in flight at a crash as a failed attempt, so only kills while streaming end the run. The node that remains
 * streams fast.
 */
export async function killWhileStreaming(home: string, child: ChildProcess, client: TestClient, threadId: string): Promise<{ child: ChildProcess; client: TestClient; kills: number }> {
	for (let kills = 0; ; kills++) {
		const threads = client.sub({ kind: "threads" });
		const row = (await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "streaming" || v.threads[threadId]?.attention, 30_000)).threads[threadId];
		if (row.attention) {
			client.close();
			await kill(child);
			return { ...(await startNode(home, 5000)), kills };
		}
		assert.ok(kills < 8, "the run ends within 8 kills");
		client.close();
		await kill(child);
		({ child, client } = await startNode(home, 5));
	}
}

export function kill(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve();
		child.once("exit", () => resolve());
		child.kill("SIGKILL");
	});
}

