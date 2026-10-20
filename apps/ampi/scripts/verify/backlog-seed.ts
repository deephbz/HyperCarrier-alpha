#!/usr/bin/env node
// Journey H seed: a warm cache's cold backlog must not delay new, resumed and live Sessions.
// Seed from mem-builder's apps/ampi/test/pi-backlog-priority.test.ts (ampi-memory-startup); incident 2026-10-19:
// only 14 of 33 live agents had a row because every cached copy queued a derive (FIFO) before them.
// Starts its own disposable hub on an OS port. Prints one JSON line; exit 0 on pass, 1 on fail.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hub } from "../../src/hub/hub.ts";
import { fixture } from "../../test/pi-fixtures.ts";

const WebSocket = createRequire(import.meta.url)("ws");
const TOKEN = "e".repeat(64);
const DAY = 86_400_000, OLD = 240, DEADLINE_MS = 60_000;
const want: Record<string, string> = { "sess-new-a": "w1:p1", "sess-new-b": "w1:p2", "sess-old7": "w1:p3", "sess-new-c": "unplaced", "sess-old200": "unplaced" };

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (id: string, parent: string | null, text: string, at = Date.now()) =>
	line({ type: "message", id, parentId: parent, timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: at } });
const session = (id: string, at: number, entries: number) =>
	line({ type: "session", version: 3, id, cwd: "/work", timestamp: new Date(at).toISOString() }) +
	Array.from({ length: entries }, (_, j) => user(`u${j}`, j ? `u${j - 1}` : null, `${id} turn ${j} ${"word ".repeat(200)}`, at)).join("");

const f = fixture();
const dir = join(f.agentDir, "sessions", "--work--"), file = (name: string) => join(dir, `${name}.jsonl`);
const cacheDir = join(f.dir, "cache"), hostDir = join(cacheDir, createHash("sha256").update("devbox").digest("hex").slice(0, 16));
mkdirSync(hostDir, { recursive: true });
// A copy per old Session, as a release before the working set left it: full bytes, an index entry, nothing derived.
const old = Date.now() - 10 * DAY, index: Record<string, { file: string; offset: number }> = {};
for (let i = 0; i < OLD; i++) {
	const bytes = session(`sess-old${i}`, old, 40);
	writeFileSync(file(`old${i}`), bytes);
	utimesSync(file(`old${i}`), new Date(old), new Date(old));
	writeFileSync(join(hostDir, `old${i}.jsonl`), bytes);
	index[file(`old${i}`)] = { file: `old${i}.jsonl`, offset: Buffer.byteLength(bytes) };
}
writeFileSync(join(hostDir, "index.json"), JSON.stringify(index));
for (const i of [7, 200]) appendFileSync(file(`old${i}`), user("again", "u39", `resumed old${i}`));
for (const name of ["new-a", "new-b", "new-c"]) writeFileSync(file(name), session(`sess-${name}`, Date.now(), 3));
const pane = (name: string, id: string) => ({
	pane_id: id, workspace_id: "w1", tab_id: "w1:tA", name, terminal_title_stripped: `pi ${name}`, cwd: "/work", agent_status: "idle", focused: false, agent: "pi",
	agent_session: { kind: "path", agent: "pi", value: file(name) },
});
f.setState({ sessionsDir: dir, workspaces: [{ workspace_id: "w1", label: "HC" }], tabs: [{ tab_id: "w1:tA", workspace_id: "w1", label: "Work" }], agents: [pane("new-a", "w1:p1"), pane("new-b", "w1:p2"), pane("old7", "w1:p3")] });

/** Backlog copies the derive Worker has finished, kept or evicted; null before the database exists. */
function derived(): number | null {
	try {
		const db = new DatabaseSync(join(hostDir, "working-set.sqlite"), { readOnly: true });
		try { return Number((db.prepare("SELECT (SELECT count(*) FROM sessions WHERE path GLOB '*/old*')+(SELECT count(*) FROM evicted WHERE path GLOB '*/old*') n").get() as { n: number }).n); }
		finally { db.close(); }
	} catch { return null; }
}

function threads(port: number): Promise<Record<string, any>> {
	return new Promise((done, fail) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${TOKEN}` } });
		const timer = setTimeout(() => { ws.terminate(); fail(new Error("threads snapshot timed out")); }, 5000);
		ws.on("open", () => ws.send(JSON.stringify({ t: "sub", sid: 1, host: "devbox", topic: { kind: "threads" } })));
		ws.on("message", (data: Buffer) => { const m = JSON.parse(String(data)); if (m.t === "snap" && m.sid === 1) { clearTimeout(timer); ws.close(); done(m.value.threads); } });
		ws.on("error", (e: Error) => { clearTimeout(timer); fail(e); });
	});
}

const hub = new Hub({ backend: "pi", models: { arcLabels: "anthropic/claude-haiku-5-5", arcSynthesis: "anthropic/claude-sonnet-5-5", rarebitRecap: "anthropic/claude-haiku-5-5", rarebitAsk: "anthropic/claude-sonnet-5-5" }, hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir,
	agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 300, teamsMs: 0 },
	env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") } }] } as any, { token: TOKEN });
const started = Date.now();
let result: Record<string, unknown> = { ok: false };
try {
	const port = await hub.listen(0);
	let rows: Record<string, string> = {}, n: number | null = null;
	for (;;) {
		const v = await threads(port);
		n = derived();
		rows = Object.fromEntries(Object.keys(want).map(id => { const s = v[`pi:${id}`]; return [id, s ? s.location?.pane ?? "unplaced" : "missing"]; }));
		const matched = JSON.stringify(rows) === JSON.stringify(want), ms = Date.now() - started;
		if (matched) { result = { ok: (n ?? 0) < OLD / 2, rows, derivedAtMatch: n, of: OLD, ms, reason: (n ?? 0) < OLD / 2 ? undefined : `rows appeared only after ${n} of ${OLD} backlog copies derived` }; break; }
		// The ordering bug shows before the deadline: most of the cold backlog derived while wanted rows are still missing.
		if ((n ?? 0) >= OLD / 2) { result = { ok: false, rows, derivedAtMiss: n, of: OLD, ms, reason: `${n} of ${OLD} backlog copies derived before every new, resumed and live Session had its row` }; break; }
		if (ms > DEADLINE_MS) { result = { ok: false, rows, derived: n, of: OLD, ms, reason: `deadline ${DEADLINE_MS} ms passed` }; break; }
		await new Promise(r => setTimeout(r, 250));
	}
} catch (error) {
	result = { ok: false, reason: (error as Error).message };
} finally {
	await hub.close().catch(() => {});
	rmSync(f.dir, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
