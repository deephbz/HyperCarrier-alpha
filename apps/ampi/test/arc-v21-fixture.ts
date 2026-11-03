import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hub } from "../src/hub/hub.ts";
import { Browser, ownHome, tempHome } from "./helpers.ts";
import { fixture, replaceFile, type Fixture } from "./pi-fixtures.ts";
import { controlRequest } from "../src/arc/service/connection.ts";
// @ts-expect-error Build script runs as native ESM.
import { buildArcService } from "../scripts/build-arc-service.mjs";

// Scope: disposable acceptance infrastructure. No Arc authority or replica logic lives here.
export async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!await check()) {
		assert.ok(Date.now() < end, `Timed out: ${label}`);
		await delay(20);
	}
}

export function assertSameReceipt(a: { revision: number; receipt: unknown }, b: { revision: number; receipt: unknown }): void {
	assert.equal(a.revision, b.revision, "Both hubs have the same receipt revision");
	assert.equal(JSON.stringify(a.receipt), JSON.stringify(b.receipt), "Both hubs have the same receipt bytes");
}

/** A process boundary shim. Each direction adds half the requested RTT. */
export function writeDelayShim(dir: string, rttMs = 300): string {
	const file = join(dir, "delayed-node");
	writeFileSync(file, `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(process.execPath)}, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const timers = new Set();
const forward = (source, target) => {
 source.on('data', chunk => {
  const timer = setTimeout(() => { timers.delete(timer); if (!target.destroyed) target.write(chunk); }, ${rttMs / 2});
  timers.add(timer);
 });
};
forward(process.stdin, child.stdin);
forward(child.stdout, process.stdout);
child.stdin.on('error', () => {});
const stop = () => { for (const t of timers) clearTimeout(t); child.kill('SIGTERM'); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop);
child.on('exit', (code) => process.exit(code ?? 0));
`, { mode: 0o755 });
	return file;
}

/** Records acceptance before blocking. The disk log survives a caller crash. */
export class RecordingModel {
	readonly log: string;
	readonly command: string[];
	readonly dir: string;
	constructor(dir: string, mode: "text" | "pi" = "text") {
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
		this.log = join(dir, "calls.jsonl");
		writeFileSync(this.log, "");
		writeFileSync(join(dir, "answer.txt"), "synthetic answer");
		const script = join(dir, "model.cjs");
		writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const pi = ${mode === "pi"};
const behavior = fs.existsSync(path.join(dir, 'behavior.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'behavior.json'), 'utf8')) : {};
if (pi && process.argv[2] === 'auth') { console.log(JSON.stringify({status: behavior.auth || 'ready'})); process.exit(behavior.auth === 'not_ready' ? 1 : 0); }
let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
 fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ input, pid: process.pid, acceptedAt: Date.now() }) + '\\n');
 const finish = () => {
  if (fs.existsSync(path.join(dir, 'blocked'))) return setTimeout(finish, 20);
  if (!pi) { process.stdout.write(fs.readFileSync(path.join(dir, 'answer.txt'))); return; }
  const source = JSON.parse(input.split('\\nAnswer rejected:')[0]);
  const last = source.rarebits.at(-1);
  const behavior = fs.existsSync(path.join(dir, 'behavior.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'behavior.json'), 'utf8')) : {};
  const count = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\\n').length;
  if (behavior.failAfter !== undefined && count > behavior.failAfter) {
   console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'synthetic', model: 'model', stopReason: 'error', errorMessage: 'Synthetic later-window failure', content: [], usage: { input: 2, output: 0, cost: { total: 0.02 } } } }));
   return;
  }
  const claim = { text: 'Review the synthetic work.', cites: [{ id: last.id, quote: last.text.slice(0, 120) }] };
  const answer = { goal: claim, now: claim, chapters: [{ firstId: source.rarebits[0].id, label: 'Synthetic work', closed: true, summary: { scope: claim, bullets: [] } }], points: behavior.drop ? [{ kind: 'request', state: 'open', by: 'owner', waits: 'owner', title: 'Synthetic invalid source', text: 'Choose the next step.', cites: [{id:'missing-synthetic-id', quote:'Missing synthetic quote'}] }] : [] };
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'synthetic', model: 'model', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input: 10, output: 5, ...(behavior.cost === null ? {} : { cost: { total: behavior.cost ?? 0.01 } }) } } }));
 };
 finish();
});
`, { mode: 0o755 });
		this.command = [process.execPath, script];
	}
	get calls(): { input: string; pid: number; acceptedAt: number }[] {
		return readFileSync(this.log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
	}
	configure(behavior: { failAfter?: number; cost?: number | null; drop?: boolean; auth?: "ready" | "not_ready" }): void {
		writeFileSync(join(this.dir, "behavior.json"), JSON.stringify(behavior));
	}
	block(): void { writeFileSync(join(this.dir, "blocked"), ""); }
	release(answer = "synthetic answer"): void {
		writeFileSync(join(this.dir, "answer.txt"), answer);
		rmSync(join(this.dir, "blocked"), { force: true });
	}
}

export type ReplicaHub = { hub: Hub; browser: Browser; stateDir: string; close(): Promise<void> };

/** Two synthetic Hosts and two independent hubs. Every link runs the real remote agent. */
export async function arcFixture(t: { after(fn: () => unknown): void }, rttMs = 300) {
	const root = tempHome();
	const hosts: Fixture[] = [fixture(), fixture()];
	const hubs: ReplicaHub[] = [];
	const models = hosts.map((host) => new RecordingModel(join(host.dir, "recording-model")));
	t.after(async () => {
		for (const hub of hubs) await hub.close();
		for (const host of hosts) rmSync(host.dir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});
	const shim = writeDelayShim(root, rttMs);
	async function launchHub(name: string): Promise<ReplicaHub> {
		const stateDir = join(root, name);
		mkdirSync(stateDir, { recursive: true });
		const home = ownHome(stateDir);
		const hub = new Hub({
			hosts: hosts.map((host, index) => ({
				id: `host-${index + 1}`, label: `host-${index + 1}`, kind: "pi-local" as const,
				cacheDir: join(stateDir, `host-${index + 1}`), remoteNode: shim,
				agentConfig: { agentDir: host.agentDir, pollMs: 30, discoverMs: 150, teams: false, arcBundle: "" },
				askCommand: models[index].command,
				env: { HOME: host.dir, AMPI_HOME: join(host.dir, "ampi"), PI_CODING_AGENT_DIR: host.agentDir,
					HERDR_BIN: join(host.dir, "herdr"), FAKE_HERDR_STATE: join(host.dir, "state.json"), FAKE_HERDR_LOG: join(host.dir, "calls.jsonl") },
			})),
			models: { rarebitAsk: "synthetic/model" },
		}, { home, token: "d".repeat(64) });
		let closed = false;
		const handle: ReplicaHub = { hub, stateDir, browser: undefined as unknown as Browser, async close() {
			if (closed) return;
			closed = true;
			handle.browser?.ws.close();
			await hub.close();
			home.release();
		} };
		hubs.push(handle);
		const port = await hub.listen(0);
		handle.browser = await Browser.open(port, undefined, `ampi_k_${port}=${"d".repeat(64)}`);
		return handle;
	}
	await launchHub("hub-a");
	await launchHub("hub-b");
	return { root, hosts, hubs, models, launchHub, append(host: number, record: unknown) {
		appendFileSync(hosts[host].sessionA, `${JSON.stringify(record)}\n`);
	} };
}

let bundles: Promise<{ older: string; newer: string }> | undefined;
async function linkBundles() {
	return bundles ??= (async () => {
		const dir = tempHome();
		try {
			const file = join(dir, "service.mjs");
			await buildArcService(file, { buildOrder: 100, releaseLine: "stable" });
			const older = readFileSync(file, "utf8");
			await buildArcService(file, { buildOrder: 200, releaseLine: "stable" });
			return { older, newer: readFileSync(file, "utf8") };
		} finally { rmSync(dir, { recursive: true, force: true }); }
	})();
}

/** Link-only failures never kill the resident Host service or its model child. */
export async function arcLinkFixture(t: { after(fn: () => unknown): void }, options: { auth?: "not_ready"; invalidSettings?: boolean; missingPi?: boolean } = {}) {
	const root = tempHome(), host = fixture(), hubs: (ReplicaHub & { sid: number; name: string; wire: string; ackHold: string; cut: string; inject: string })[] = [];
	const model = new RecordingModel(join(host.dir, "recording-link-model"), "pi"), bodies = await linkBundles();
	if (options.auth) model.configure({ auth: options.auth });
	const store = join(host.agentDir, "ampi-arc"), settingsPath = join(host.agentDir, "settings.json");
	const settings = (value: unknown = { model: "synthetic/model", auto: false, retries: 0 }) => replaceFile(settingsPath, JSON.stringify({ ampi_arc: value }));
	settings(options.invalidSettings ? { model: 17 } : undefined);
	const at = new Date().toISOString();
	replaceFile(host.sessionA, [ { type: "session", version: 3, id: "sess-a", timestamp: at, cwd: "/synthetic/work" },
		...Array.from({ length: 6 }, (_, n) => ({ type: "message", id: `u${n}`, parentId: n ? `u${n - 1}` : null, timestamp: at, message: { role: "user", content: `Synthetic owner evidence ${n}.` } })) ].map(row => JSON.stringify(row)).join("\n") + "\n");
	const wireRows = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
	async function launchHub(name: string, body = bodies.older) {
		const stateDir = join(root, name), wire = join(root, `${name}.wire.jsonl`), ackHold = join(root, `${name}.hold-acks`), cut = join(root, `${name}.cut`), inject = join(root, `${name}.inject`);
		mkdirSync(stateDir, { recursive: true });
		const shim = join(root, `${name}-node`);
		writeFileSync(shim, `#!${process.execPath}
const fs=require('node:fs'), {spawn}=require('node:child_process');
const wire=${JSON.stringify(wire)}, hold=${JSON.stringify(ackHold)}, cut=${JSON.stringify(cut)}, inject=${JSON.stringify(inject)};
if(fs.existsSync(cut))process.exit(0);
const child=spawn(${JSON.stringify(process.execPath)},process.argv.slice(2),{stdio:['pipe','pipe','inherit'],env:process.env});
const timers=new Set();
const later=fn=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},150);timers.add(timer);};
const record=(direction,frame)=>fs.appendFileSync(wire,JSON.stringify({direction,frame})+'\\n');
let input='',output='';
process.stdin.on('data',b=>{input+=b;let at;while((at=input.indexOf('\\n'))>=0){const line=input.slice(0,at);input=input.slice(at+1);try{const frame=JSON.parse(line);if(frame.t)record('in',frame);}catch{}later(()=>{if(!child.stdin.destroyed)child.stdin.write(line+'\\n');});}});
child.stdout.on('data',b=>{output+=b;let at;while((at=output.indexOf('\\n'))>=0){const line=output.slice(0,at);output=output.slice(at+1);let frame;try{frame=JSON.parse(line);if(frame.t.startsWith('arc.'))record('out',frame);}catch{}if(frame?.t==='arc.ack'&&fs.existsSync(hold))continue;later(()=>process.stdout.write(line+'\\n'));}});
const tick=setInterval(()=>{if(fs.existsSync(cut)){child.kill();process.exit(0);}if(fs.existsSync(inject)){const text=fs.readFileSync(inject,'utf8');fs.unlinkSync(inject);for(const line of text.trim().split('\\n')){if(!line)continue;record('inject',JSON.parse(line));later(()=>process.stdout.write(line+'\\n'));}}},20);
const stop=()=>{clearInterval(tick);for(const timer of timers)clearTimeout(timer);child.kill();process.exit(0);};
process.on('SIGTERM',stop);process.stdin.on('end',stop);child.on('exit',()=>process.exit(0));child.stdin.on('error',()=>{});
`, { mode: 0o755 });
		const home = ownHome(stateDir);
		const config = { id: "host-1", label: "host-1", kind: "pi-local" as const, cacheDir: join(stateDir, "host"), remoteNode: shim,
			agentConfig: { agentDir: host.agentDir, pollMs: 30, discoverMs: 150, teams: false, arcBundle: body },
			env: { HOME: host.dir, AMPI_HOME: join(host.dir, "ampi"), PI_BIN: options.missingPi ? join(host.dir, "missing-pi") : model.command[1], PI_CODING_AGENT_DIR: host.agentDir,
				HERDR_BIN: join(host.dir, "herdr"), FAKE_HERDR_STATE: join(host.dir, "state.json"), FAKE_HERDR_LOG: join(host.dir, "calls.jsonl") } };
		const hub = new Hub({ hosts: [config] }, { home, token: "a".repeat(64) });
		let closed = false;
		const handle = { hub, stateDir, name, wire, ackHold, cut, inject, browser: undefined as unknown as Browser, sid: 0, async close() {
			if (closed) return; closed = true; handle.browser?.ws.close(); await hub.close(); home.release();
		} };
		hubs.push(handle);
		const port = await hub.listen(0); handle.browser = await Browser.open(port, undefined, `ampi_k_${port}=${"a".repeat(64)}`);
		const threads = handle.browser.sub("host-1", { kind: "threads" });
		await handle.browser.until<any>(threads, v => Boolean(v.threads["pi:sess-a"]), 10_000).catch(error => { throw new Error(`${error.message}; hosts=${JSON.stringify(handle.browser.hosts)}; wire=${JSON.stringify(wireRows(wire).slice(-3))}`); });
		handle.sid = handle.browser.sub("host-1", { kind: "view", view: "arc", threadId: "pi:sess-a" });
		await handle.browser.until<any>(handle.sid, v => Boolean(v.services?.[0]?.state && v.services[0].state !== "unreachable"), 20_000);
		return handle;
	}
	t.after(async () => {
		model.release();
		for (const hub of hubs) await hub.close();
		try { const s = await controlRequest(store, { op: "status", refreshAuth: false }, 1000); await controlRequest(store, { op: "stop" }, 1000); if (s.pid) { try { process.kill(s.pid, "SIGKILL"); } catch {} } } catch {}
		for (const call of model.calls) { try { process.kill(call.pid, "SIGKILL"); } catch {} }
		rmSync(root, { recursive: true, force: true }); rmSync(host.dir, { recursive: true, force: true });
	});
	await launchHub("hub-a"); await launchHub("hub-b");
	const ready = async () => { for (const hub of hubs.slice(-2)) await hub.browser.until<any>(hub.sid, v => v.canDismiss === true, 20_000); };
	const command = (hub: typeof hubs[number], requestId: string, rebuild = false) => hub.browser.req("host-1", "view.arc.build", { threadId: "pi:sess-a", requestId, rebuild });
	const complete = (hub: typeof hubs[number]) => hub.browser.until<any>(hub.sid, v => v.receipt && v.status.state === "idle", 20_000);
	const query = (command: Record<string, unknown>) => controlRequest(store, { stamp: JSON.parse(readFileSync(join(store, "control.json"), "utf8")).selected, ...command } as any);
	return { root, host, hubs, model, bodies, store, settings, settingsPath, launchHub, ready, command, complete, query, wireRows,
		inject(hub: typeof hubs[number], ...frames: unknown[]) { replaceFile(hub.inject, frames.map(frame => JSON.stringify(frame)).join("\n") + "\n"); } };
}
