import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { PiHost } from "../src/pi/host.ts";
import { setup } from "./pi-host-fixtures.ts";

// pgrep exits 1 when nothing matches, as between the kill and the reconnect.
const agents = (): number[] => {
	try {
		return execFileSync("pgrep", ["-P", String(process.pid), "-f", "Buffer.from"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
	} catch (error) {
		if ((error as { status?: number }).status === 1) return [];
		throw error;
	}
};

// Incident 2026-10-29: the live agent hung inside process.exit for days. It never closed, so the hub never
// reconnected and every mirrored Session froze. A stopped agent is the same failure: no frames, no close.
test("a link whose agent sends no frame and never exits is killed, and the Host reconnects", async (t) => {
	const silent = PiHost.SILENT_MS;
	const tick = PiHost.SILENT_TICK_MS;
	PiHost.SILENT_MS = 800;
	PiHost.SILENT_TICK_MS = 100;
	t.after(() => {
		PiHost.SILENT_MS = silent;
		PiHost.SILENT_TICK_MS = tick;
	});
	const { hub, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.live);
	const link = hub.link("devbox") as PiHost;
	const [stuck] = agents();
	assert.ok(stuck, "the Host runs one agent");
	process.kill(stuck, "SIGSTOP");
	t.after(() => {
		try {
			process.kill(stuck, "SIGKILL");
		} catch {}
	});

	// The disconnected state lasts only until the reconnect starts; a poll can miss it, an event cannot. The old
	// link still reads connected after the kill until its close arrives, so wait for a disconnect, then a connect.
	let reason = "";
	let reconnected = false;
	const record = (state: { status: string; error?: string }) => {
		if (state.status === "disconnected") reason ||= String(state.error ?? "");
		else if (state.status === "connected" && reason) reconnected = true;
	};
	link.on("state", record);
	t.after(() => link.off("state", record));
	const by = Date.now() + 10_000;
	while (Date.now() < by && !(reconnected && !agents().includes(stuck)))
		await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(link.state.status, "connected", "the Host reconnected with a new agent");
	assert.ok(!agents().includes(stuck), "the silent agent was killed");
	assert.match(reason, /No frame from the Pi agent for \d+ s; the hub stopped it/, "the disconnect names the silence");
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.live);
});
