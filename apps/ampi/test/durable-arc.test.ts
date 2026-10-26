import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { Hub } from "../src/hub/hub.ts";
import { Browser, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const TOKEN = "f".repeat(64);

/**
 * An offline helper model on stdin/stdout: labels every chunk, and answers synthesis with one thread and one ask per
 * ask candidate. Each call appends its request to `calls`.
 */
function offlineModel(calls: string): string {
	return `const fs=require('node:fs');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(p)+'\\n');const all=JSON.stringify(p);const id=(all.match(/\\[([^\\]]+)\\] (?:USER|AGENT):/)||[])[1];const qs=[...new Set(all.match(/\\bq[0-9]+\\b/g)||[])];console.log(JSON.stringify(p.chunks?{chunks:p.chunks.map(c=>({chunk:c.chunk,topic:'Cache change',project:'Fixture',ideas:[]}))}:{headline:'Cache change',projects:[],transitions:[],asks:qs.map(q=>({candidates:[q],text:'Decide whether to ship the cache change',kind:'decision',answeredBy:null})),threads:[{label:'Cache change',state:'waiting',progress:[{text:'The agent asked to ship',citations:[id]}],decisions:[],blockers:[]}],unassigned:{progress:[],decisions:[],blockers:[]}}));});`;
}

test("durable arc: a stopped open thread starts the automatic Arc Build through the hub's helper models, and its row carries arc.asks", async (t) => {
	const home = tempHome();
	const calls = join(home, "ask-calls.jsonl");
	writeFileSync(calls, "");
	const daemon = await runDaemon({ home });
	const hub = new Hub({ models: { arcLabels: "fixture/synthetic", arcSynthesis: "fixture/synthetic" },
		hosts: [{ id: "devbox", label: "devbox", kind: "local", home, askCommand: [process.execPath, "-e", offlineModel(calls)] }] }, { token: TOKEN });
	const port = await hub.listen(0);
	const b = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
	t.after(async () => { b.ws.terminate(); await hub.close(); await daemon.stop(); });
	await b.when(() => b.hosts.some((h) => h.id === "devbox" && h.status === "connected"), 5000, "durable host");

	const threads = b.sub("devbox", { kind: "threads" });
	const { threadId } = await b.req("devbox", "thread.create", { requestId: "arc", cwd: home, model: SIM, prompt: "Decision needed: ship the cache change today.", place: { workspace: "new", label: "main" } });
	await b.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle");
	await b.req("devbox", "thread.submit", { threadId, content: "Check the build first. Decision needed: ship after that." });
	// The fourth Rarebit message passes the floor; the stop after it starts the Build with no owner action.
	const arc = b.sub("devbox", { kind: "view", view: "cos.arc", threadId });
	const built = await b.until<any>(arc, (v) => v.builds?.some((r: any) => r.state === "done" || r.state === "error"), 10_000);
	const run = built.builds.find((r: any) => r.state === "done" || r.state === "error");
	assert.equal(run.state, "done", JSON.stringify(run));
	assert.equal(run.trigger, "auto");
	assert.deepEqual(run.models, { labels: "fixture/synthetic", synthesis: "fixture/synthetic" });
	assert.ok(run.calls >= 2, `label and synthesis calls: ${run.calls}`);
	const asked = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
	assert.equal(asked.length, run.calls, "every call went through the hub's ask command");

	const row = await b.until<any>(threads, (v) => v.threads[threadId]?.arc?.asks?.length > 0, 5000);
	assert.equal(row.threads[threadId].live, true);
	assert.deepEqual(row.threads[threadId].arc.asks.map((a: any) => a.kind), ["decision"]);
	assert.deepEqual(b.gaps, []);
});
