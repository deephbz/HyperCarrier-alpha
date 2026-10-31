import "./bound.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import { Browser } from "./helpers.ts";
import { fixture } from "./pi-fixtures.ts";

const TOKEN = "e".repeat(64);
const DAY = 86_400_000, OLD = 240;
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (id: string, parent: string | null, text: string, at = Date.now()) => line({ type: "message", id, parentId: parent, timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text }] } });
const session = (id: string, at: number, entries: number) => line({ type: "session", version: 3, id, cwd: "/work", timestamp: new Date(at).toISOString() })
 + Array.from({ length: entries }, (_, j) => user(`u${j}`, j ? `u${j - 1}` : null, `${id} turn ${j} ${"word ".repeat(200)}`, at)).join("");

// Deployment 2026-10-19: a warm cache from before the working set re-derived every copy at start.
// Only 14 of 33 live agents had a row; today's 25 Sessions were neither derived nor evicted.
test("pi working set: new, appended and live Sessions get rows before a warm cache's cold backlog derives (only 14 of 33 live agents had rows)", async (t) => {
 const f = fixture();
 const dir = join(f.agentDir, "sessions", "--work--"), file = (name: string) => join(dir, `${name}.jsonl`);
 const cacheDir = join(f.dir, "cache"), hostDir = join(cacheDir, createHash("sha256").update("devbox").digest("hex").slice(0, 16));
 mkdirSync(hostDir, { recursive: true });
 // A copy per old Session, as the previous release left it: full bytes, an index entry, nothing derived.
 const old = Date.now() - 10 * DAY, index: Record<string, { file: string; offset: number }> = {};
 for (let i = 0; i < OLD; i++) {
  const bytes = session(`sess-old${i}`, old, 40);
  writeFileSync(file(`old${i}`), bytes); utimesSync(file(`old${i}`), new Date(old), new Date(old));
  writeFileSync(join(hostDir, `old${i}.jsonl`), bytes);
  index[file(`old${i}`)] = { file: `old${i}.jsonl`, offset: Buffer.byteLength(bytes) };
 }
 writeFileSync(join(hostDir, "index.json"), JSON.stringify(index));
 // Two old Sessions resume today, so their sources grow past the copies.
 for (const i of [7, 200]) appendFileSync(file(`old${i}`), user("again", "u39", `resumed old${i}`));
 for (const name of ["new-a", "new-b", "new-c"]) writeFileSync(file(name), session(`sess-${name}`, Date.now(), 3));
 const pane = (name: string, id: string) => ({ pane_id: id, workspace_id: "w1", tab_id: "w1:tA", name, terminal_title_stripped: `pi ${name}`, cwd: "/work", agent_status: "idle", focused: false, agent: "pi", agent_session: { kind: "path", agent: "pi", value: file(name) } });
 f.setState({ sessionsDir: dir, workspaces: [{ workspace_id: "w1", label: "HC" }], tabs: [{ tab_id: "w1:tA", workspace_id: "w1", label: "Work" }], agents: [pane("new-a", "w1:p1"), pane("new-b", "w1:p2"), pane("old7", "w1:p3")] });
 const hub = new Hub({ hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir,
  agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 300, teamsMs: 0 },
  env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") } }] }, { token: TOKEN });
 const port = await hub.listen(0);
 const browser = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
 t.after(async () => { browser.ws.close(); await hub.close(); });
 const threads = browser.sub("devbox", { kind: "threads" });
 const want = { "sess-new-a": "w1:p1", "sess-new-b": "w1:p2", "sess-old7": "w1:p3", "sess-new-c": "unplaced", "sess-old200": "unplaced" };
 const shape = (v: any) => Object.fromEntries(Object.keys(want).map((id) => { const s = v.threads[`pi:${id}`]; return [id, s ? s.location?.pane ?? "unplaced" : "missing"]; }));
 let last: Record<string, string> = {};
 try { await browser.until<any>(threads, (v) => JSON.stringify(last = shape(v)) === JSON.stringify(want), 60_000); }
 catch { assert.deepEqual(last, want, "every new, resumed and live Session has a row"); }
 assert.ok(statSync(file("old7")).size > index[file("old7")].offset);
 const db = new DatabaseSync(join(hostDir, "working-set.sqlite"), { readOnly: true });
 const derived = Number((db.prepare("SELECT (SELECT count(*) FROM sessions WHERE path GLOB '*/old*')+(SELECT count(*) FROM evicted WHERE path GLOB '*/old*') n").get() as { n: number }).n);
 db.close();
 assert.ok(derived < OLD / 2, `rows appeared only after ${derived} of ${OLD} backlog copies derived`);
});
