#!/usr/bin/env node
// Journey H, row i controls: after a Herdr outage and after a Host agent outage, live rows and their panes match
// Herdr again within 60 s. Seed (lead, 2026-10-19): 89521d6 at load 245 showed 99 rows with live 0 and location 0
// against 32 panes, while the local agent restarted every ~30 s (stdout ENOBUFS, then exit 0).
// Starts its own disposable hub on an OS port, so killing its agent cannot disturb other journeys.
// Prints one JSON line; exit 0 on pass, 1 on fail.
import "../stdio-sync.cjs";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../../src/hub/hub.ts";
import { fixture } from "../../test/pi-fixtures.ts";
import { agentPids, agentWatch, paneCoverage, threadsSnapshot } from "./live-rows.mjs";

const TOKEN = "f".repeat(64), RECOVER_MS = 60_000, STABLE_MS = Number(process.env.STABLE_MS ?? 3000);
const f = fixture();
const dir = join(f.agentDir, "sessions", "--work--"), statePath = join(f.dir, "state.json");
const now = new Date().toISOString();
const names = ["live-a", "live-b", "live-c"];
for (const name of names) writeFileSync(join(dir, `${name}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id: `sess-${name}`, cwd: "/work", timestamp: now })}\n`);
const agents = names.map((name, i) => ({
	pane_id: `w1:p${i + 1}`, workspace_id: "w1", tab_id: "w1:tA", name, terminal_title_stripped: `pi ${name}`, cwd: "/work", agent_status: "idle", focused: false, agent: "pi",
	agent_session: { kind: "path", agent: "pi", value: join(dir, `${name}.jsonl`) },
}));
f.setState({ sessionsDir: dir, workspaces: [{ workspace_id: "w1", label: "HC" }], tabs: [{ tab_id: "w1:tA", workspace_id: "w1", label: "Work" }], agents });

const hub = new Hub({ models: { arcLabels: "anthropic/claude-haiku-5-5", arcSynthesis: "anthropic/claude-sonnet-5-5", rarebitAsk: "anthropic/claude-sonnet-5-5" }, hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: join(f.dir, "cache"),
	agentConfig: { agentDir: f.agentDir, pollMs: 50, discoverMs: 300, teamsMs: 0 },
	env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: statePath, FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") } }] } as any, { token: TOKEN });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const watch = agentWatch(process.pid);
let port = 0;
/** Polls until every pane matches; resolves the time it took, or throws with the last coverage. */
async function covered(label: string, since = Date.now()) {
	let last: unknown;
	while (Date.now() - since < RECOVER_MS) {
		watch.sample();
		try {
			const report = paneCoverage(agents, await threadsSnapshot({ port, host: "devbox", auth: { bearer: TOKEN } }), { activity: false });
			if (report.ok) return Date.now() - since;
			last = report.problems;
		} catch (error) { last = (error as Error).message; }
		await sleep(200);
	}
	throw new Error(`${label}: panes did not match within ${RECOVER_MS} ms: ${JSON.stringify(last)}`);
}
const result: Record<string, unknown> = { ok: false };
try {
	port = await hub.listen(0);
	result.startMs = await covered("start");
	// Stability: the agent pid holds for the window.
	const stableFrom = Date.now();
	while (Date.now() - stableFrom < STABLE_MS) { watch.sample(); await sleep(200); }
	result.stable = { windowMs: Date.now() - stableFrom, restarts: watch.restarts, pids: watch.history };
	if (watch.restarts || !agentPids(process.pid).length) throw new Error(`agent not stable: ${JSON.stringify(result.stable)}`);
	// Herdr outage: the fake CLI fails while its state file is away.
	renameSync(statePath, `${statePath}.away`);
	await sleep(2000);
	renameSync(`${statePath}.away`, statePath);
	result.herdrRecoverMs = await covered("after Herdr outage");
	// Agent outage: kill the Host agent. The sampler must see the restart (red control) and the rows must return.
	const before = watch.restarts, [pid] = agentPids(process.pid);
	process.kill(pid, "SIGKILL");
	const killedAt = Date.now();
	while (!agentPids(process.pid).length || agentPids(process.pid)[0] === pid) { if (Date.now() - killedAt > RECOVER_MS) throw new Error("agent did not restart"); await sleep(100); }
	result.agentRecoverMs = await covered("after agent outage", killedAt);
	watch.sample();
	result.restartSeen = watch.restarts > before;
	if (!result.restartSeen) throw new Error("the sampler missed the agent restart");
	result.ok = true;
} catch (error) {
	result.reason = (error as Error).message;
} finally {
	await hub.close().catch(() => {});
	rmSync(f.dir, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
