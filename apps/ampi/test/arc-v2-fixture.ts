// Independent Arc v2 boundary fixture. Only Hub transport and synthetic Session files are inputs.
// Model scripts return answers by call/window; they do not parse an implementation-owned prompt schema.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import { Browser } from "./helpers.ts";
import { fixture, replaceFile } from "./pi-fixtures.ts";

// Keep newly discovered synthetic Sessions inside the reader's 96-hour working set.
export const T = Date.now() - 3_600_000;
export const DEFAULT_MODEL = "anthropic/claude-haiku-5-5";
export const jsonLine = (value: unknown) => JSON.stringify(value) + "\n";
export type Evidence = { id: string; role: "user" | "assistant"; text: string; parent?: string | null };
export const evidence = (id: string, role: Evidence["role"] = "user", text = `Synthetic evidence ${id}.`): Evidence => ({ id, role, text });
export const initial = [evidence("u1"), evidence("a1", "assistant"), evidence("u2"), evidence("a2", "assistant")];
export function message(e: Evidence, parent: string | null, index: number) {
	return jsonLine({ type: "message", id: e.id, parentId: e.parent === undefined ? parent : e.parent, timestamp: new Date(T + index * 60_000).toISOString(), message: { role: e.role, content: [{ type: "text", text: e.text }], ...(e.role === "assistant" ? { stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, cost: { total: .01 } } } : {}) } });
}
export const cite = (id = "u1", quote = `Synthetic evidence ${id}.`) => ({ id, quote });
export const claim = (text = "The owner requested synthetic work.", id = "u1", quote?: string) => ({ text, cites: [cite(id, quote)] });
export const chapter = (firstId = "u1", closed = false) => ({ firstId, label: closed ? "Completed synthetic work" : "Completing synthetic work", closed, summary: { scope: claim("The owner requested synthetic work.", firstId), bullets: [claim("The work has supporting evidence.", firstId)] } });
export const point = (extra: Record<string, unknown> = {}) => ({ kind: "request", state: "open", by: "owner", waits: "owner", title: "Choose the next step", text: "Open: the owner must choose the next step.", cites: [cite()], ...extra });
export function answer(extra: Record<string, unknown> = {}): any {
	return { goal: claim(), now: claim("The work waits for the owner."), chapters: [chapter()], points: [point()], ...extra };
}
export type Step = { answer?: unknown; raw?: string; error?: string; gate?: string };
export type Call = { event: "start" | "end"; n: number; at: number; prompt?: string; system?: string; model?: string };
export type ArcValue = { receipt?: any; stale: number; branchChanged: boolean; status: { state: string; nextAt?: string; progress?: string; error?: { code: string; message: string } } };

export async function setup(t: TestContext, options: { entries?: Evidence[]; steps?: Step[]; arc?: unknown; omitSettings?: boolean } = {}) {
	const f = fixture();
	const gates: string[] = [];
	// bound.ts has already isolated the hub's global Pi directory. The host's Session
	// directory is separate; putting settings there would test the wrong authority.
	const settings = join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
	rmSync(settings, { force: true });
	t.after(() => rmSync(settings, { force: true }));
	const setSettings = (arc: unknown) => replaceFile(settings, JSON.stringify({ ampi_arc: arc }));
	if (!options.omitSettings) setSettings(options.arc ?? { auto: false });
	let entries = options.entries ?? initial;
	let parent: string | null = null, count = 0;
	const sessionText = (id: string, rows: Evidence[]) => {
		let p: string | null = null;
		return jsonLine({ type: "session", version: 3, id, timestamp: new Date(T).toISOString(), cwd: "/work" }) + rows.map((e, i) => { const s = message(e, p, i); p = e.id; return s; }).join("");
	};
	writeFileSync(f.sessionA, sessionText("sess-a", entries));
	parent = entries.at(-1)?.id ?? null; count = entries.length;
	const callsFile = join(f.dir, "arc-model-calls.jsonl"), planFile = join(f.dir, "arc-model-plan.json");
	const steps = options.steps ?? [{ answer: answer() }];
	const plan = (next: Step[]) => replaceFile(planFile, JSON.stringify(next));
	plan(steps);
	const modelFile = join(f.dir, "arc-model.cjs");
	writeFileSync(modelFile, `const fs=require('node:fs');
const calls=${JSON.stringify(callsFile)}, plan=${JSON.stringify(planFile)};
let prompt=''; process.stdin.on('data', d=>prompt+=d).on('end', async()=>{
 const lock=calls+'.lock';
 while(true){try{fs.mkdirSync(lock);break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,5));}}
 const current=fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
 const n=current.filter(x=>x.event==='start').length;
 const log=x=>fs.appendFileSync(calls,JSON.stringify({...x,n,at:Date.now()})+'\\n');
 const detail=calls+'.'+n+'.json';
 fs.writeFileSync(detail+'.tmp',JSON.stringify({prompt,system:fs.readFileSync(process.env.AMPI_ASK_SYSTEM_FILE,'utf8'),model:process.env.AMPI_ASK_MODEL}));
 fs.renameSync(detail+'.tmp',detail);
 log({event:'start'});
 fs.rmdirSync(lock);
 const steps=JSON.parse(fs.readFileSync(plan,'utf8')), step=steps[n]||steps.at(-1);
 if(!step){console.error('Missing synthetic answer');process.exit(2);}
 if(step.gate) { const until=Date.now()+45000; while(!fs.existsSync(step.gate)&&Date.now()<until) await new Promise(r=>setTimeout(r,20)); if(!fs.existsSync(step.gate)){console.error('Synthetic gate timeout');process.exit(2);} }
 log({event:'end'});
 if(step.error){ console.error(step.error);process.exit(2); }
 console.log(step.raw===undefined?JSON.stringify(step.answer):step.raw);
});`);
	const askCommand = [process.execPath, modelFile];
	const hub = new Hub({ hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: join(f.dir, "cache"), askCommand, agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teams: false }, env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") } }] }, { token: "d".repeat(64) });
	const port = await hub.listen(0);
	const browser = await Browser.open(port, undefined, `ampi_k_${port}=${"d".repeat(64)}`);
	t.after(async () => { for (const gate of gates) writeFileSync(gate, "released"); browser.ws.close(); await hub.close(); });
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, v => Boolean(v.threads["pi:sess-a"]));
	const sid = browser.sub("devbox", { kind: "view", view: "arc", threadId: "pi:sess-a" });
	// A missing v2 topic fails here, before any assertions about model output.
	await browser.when(() => Boolean((browser.values.get(sid) as ArcValue | undefined)?.status) || browser.closing.get(sid)?.t === "end", 3000, "Arc v2 topic");
	assert.ok((browser.values.get(sid) as ArcValue | undefined)?.status, `Arc v2 topic did not publish status: ${JSON.stringify(browser.closing.get(sid))}`);
	const calls = (): Call[] => existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(s => { const c = JSON.parse(s); return c.event === "start" ? { ...c, ...JSON.parse(readFileSync(`${callsFile}.${c.n}.json`, "utf8")) } : c; }) : [];
	const starts = () => calls().filter(c => c.event === "start");
	const value = () => browser.values.get(sid) as ArcValue;
	// A Build refuses a Session that is still being read. Under load a large fixture Session can take seconds to read.
	const rarebit = browser.sub("devbox", { kind: "view", view: "rarebit", threadId: "pi:sess-a" });
	async function build(rebuild = false) {
		await browser.until<any>(rarebit, v => v?.source?.state === "ready");
		const before = value().receipt?.builtAt;
		await browser.req("devbox", "view.arc.build", { threadId: "pi:sess-a", rebuild });
		return browser.until<ArcValue>(sid, v => v.status.state === "failed" || v.status.state === "queued" && Boolean(v.status.error) || (v.status.state === "idle" && Boolean(v.receipt) && v.receipt.builtAt !== before), 12_000);
	}
	function append(...rows: Evidence[]) {
		for (const e of rows) { appendFileSync(f.sessionA, message(e, parent, count++)); parent = e.id; entries = [...entries, e]; }
	}
	return { f, browser, threads, sid, settings, setSettings, plan, calls, starts, value, build, append, askCommand, sessionText,
		gate(name: string) { const file = join(f.dir, name); gates.push(file); return file; },
		release(file: string) { writeFileSync(file, "released"); },
		writeSession(id: string, rows: Evidence[], headerId = id) { const file = join(f.agentDir, "sessions", "--work--", `${id}.jsonl`); mkdirSync(join(f.agentDir, "sessions", "--work--"), { recursive: true }); replaceFile(file, sessionText(headerId, rows)); return file; },
	};
}
export function done(v: ArcValue) {
	assert.equal(v.status.state, "idle", JSON.stringify(v.status));
	assert.ok(v.receipt, "a successful Build publishes a receipt");
	assert.equal(v.receipt.builds.at(-1)?.state === "done" || v.receipt.builds[0]?.state === "done", true);
	return v.receipt;
}
export async function waitFor(predicate: () => boolean, what: string, ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (predicate()) return; await new Promise(r => setTimeout(r, 25)); }
	assert.fail(`Timed out: ${what}`);
}
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
