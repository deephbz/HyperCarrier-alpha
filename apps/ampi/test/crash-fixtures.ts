import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { socketPath } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";

export const BIN = fileURLToPath(new URL("../bin/ampi.mjs", import.meta.url));
export const SIM = { provider: "ampi-sim", modelId: "sim-1" };

/** A real `ampi node` process, so the crash is a SIGKILL with no shutdown path. */
export async function startNode(home: string, tps: number, env: Record<string, string> = {}): Promise<{ child: ChildProcess; client: TestClient }> {
	const child = spawn(process.execPath, [BIN, "node"], { env: { ...process.env, AMPI_HOME: home, AMPI_SIM_TPS: String(tps), ...env }, stdio: "ignore" });
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			return { child, client: await TestClient.connect(socketPath(home)) };
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((r) => setTimeout(r, 100));
		}
	}
}

export function kill(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve();
		child.once("exit", () => resolve());
		child.kill("SIGKILL");
	});
}

