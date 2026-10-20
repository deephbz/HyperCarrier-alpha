import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { Browser, tempHome } from "./helpers.ts";

// Runs against a real SSH destination whose login has `ampi` on PATH (see apps/ampi/README.md, "Remote hosts").
const target = process.env.AMPI_TEST_SSH_TARGET;
const SIM = { provider: "ampi-sim", modelId: "sim-1" };

test("ssh: one hub drives a local and a remote node; remote work continues through a dropped link", { skip: !target && "set AMPI_TEST_SSH_TARGET" }, async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: await hydrate() });
	const hub = new Hub({
		hosts: [
			{ id: "local", label: "Local", kind: "local", home },
			{ id: "devbox", label: "devbox", kind: "ssh", target: target! },
		],
	}, { token: "c".repeat(64) });
	const port = await hub.listen(0);
	let created = "";
	try {
		const browser = await Browser.open(port, undefined, `ampi_k_${port}=${"c".repeat(64)}`);
		await browser.when(() => browser.hosts.length === 2 && browser.hosts.every((h) => h.status === "connected"), 20_000, "both hosts connected");
		const remote = browser.hosts.find((h) => h.id === "devbox");
		const local = browser.hosts.find((h) => h.id === "local");
		assert.notEqual(remote.node.nodeId, local.node.nodeId, "two distinct nodes");
		const remoteUser = remote.node.user;

		// A remote thread runs its tools on the remote host.
		const { threadId } = await browser.req("devbox", "thread.create", { cwd: "~", model: SIM, prompt: "/sim bash whoami && hostname" });
		created = threadId;
		const view = browser.sub("devbox", { kind: "thread", threadId });
		const first = await browser.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "assistant" && e.stop === "stop"), 20_000);
		assert.match(first.entries.find((e: any) => e.kind === "tool-result").text, new RegExp(remoteUser));
		const threads = browser.sub("devbox", { kind: "threads" });
		await browser.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle");

		// Start slow remote work, then drop the SSH link mid-run. The remote node keeps working; the hub marks the
		// host disconnected and the view stale, reconnects, and the replica catches up with what happened meanwhile.
		await browser.req("devbox", "thread.submit", { threadId, content: "/sim bash sleep 4; echo finished-while-away" });
		await browser.until<any>(threads, (v) => v.threads[threadId]?.activity !== "idle", 10_000);
		execFileSync("pkill", ["-f", `ssh -T .* -- ${target} ampi bridge`]);
		await browser.when(() => browser.hosts.find((h) => h.id === "devbox")?.status !== "connected", 10_000, "link drop noticed");
		assert.ok(browser.stale.has(view), "the open view is marked stale while the host is away");
		const atDrop = browser.values.get(view) as any;
		assert.ok(!atDrop.entries.some((e: any) => e.kind === "tool-result" && /finished-while-away/.test(e.text)), "the work had not finished when the link dropped");
		await browser.when(() => browser.hosts.find((h) => h.id === "devbox")?.status === "connected", 20_000, "reconnected");
		await browser.until<any>(
			view,
			(v) =>
				v.entries.some((e: any) => e.kind === "tool-result" && /finished-while-away/.test(e.text)) &&
				v.entries.filter((e: any) => e.kind === "assistant" && e.stop === "stop").length === 2,
			20_000,
		);
		assert.deepEqual(browser.gaps, []);
		// The remote host is the owner's real node: leave no test thread in their list.
		await browser.req("devbox", "thread.archive", { threadId: created });
		browser.ws.close();
	} finally {
		await hub.close();
		await daemon.stop();
	}
});
