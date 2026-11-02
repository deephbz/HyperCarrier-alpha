import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoContext } from "./index.ts";
import WebSocket from "ws";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { ArcValue } from "../../src/shared/protocol.ts";

/** DEMO_STRESS=200 adds real synthetic Session files, through the real reader and hub. */
export function cosDemo({ dir, agentDir, now, sessions }: DemoContext) {
	const count = Math.max(0, Math.min(1000, Number(process.env.DEMO_STRESS) || 0));
	const root = join(agentDir, "sessions", "--work-stress--");
	mkdirSync(root, { recursive: true });
	for (let n = 0; n < count; n++) {
		const start = now - (68 - n % 64) * 3600_000;
		const id = `stress-${n}`;
		const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: new Date(start).toISOString(), cwd: "/work/synthetic" }];
		let parent: string | null = null;
		for (let i = 0; i < 48; i++) {
			const t = start + i * (2 + n % 6) * 60_000;
			const u = `${id}-u${i}`, a = `${id}-a${i}`;
			lines.push({ type: "message", id: u, parentId: parent, timestamp: new Date(t).toISOString(), message: { role: "user", content: [{ type: "text", text: `Synthetic Session ${n}: 日本語 · Übersetzungen · step ${i}` }] } });
			lines.push({ type: "message", id: a, parentId: u, timestamp: new Date(t + 30_000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Synthetic evidence only." }], usage: { input: 130 + n * 3, output: 71 + i * 2, cacheRead: 450, cacheWrite: 23, cost: { total: (1 + n % 7) * (1 + i % 3) * .001 } } } });
			parent = a;
		}
		writeFileSync(join(root, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	}
	// One long synthetic Session contains questions, owner replies and an unresolved blocker.
	const asksRoot = join(agentDir, "sessions", "--work-asks--");
	mkdirSync(asksRoot, { recursive: true });
	const asks: Record<number, string> = {
		20: "The reader cache is done.\n\nShould I cap it at 64 MB or keep LRU only?",
		40: "Profiling shows the derive worker at 2 s.\n\n## Decisions for you\n1. Roll the hub to the second Host now?\n2. Keep the old receipt format for one release?",
		60: "Waiting for you to give the staging SSH alias.",
		80: "The CI runner is out of disk. To unblock it, approve a larger runner.",
		100: "Still pending from earlier.\n\nShould I cap it at 64 MB or keep LRU only?",
	};
	const asksStart = now - 30 * 3600_000;
	const asksLines: unknown[] = [{ type: "session", version: 3, id: "sess-asks", timestamp: new Date(asksStart).toISOString(), cwd: "/work/demo" }];
	for (let i = 0, parent: string | null = null; i < 110; i++) {
		const t = asksStart + i * 15 * 60_000, u = `asks-u${i}`, a = `asks-a${i}`;
		const owner = i === 41 ? "Yes, roll the hub to the second Host now." : `Synthetic step ${i}: continue the reader work.`;
		if (i <= 80) asksLines.push({ type: "message", id: u, parentId: parent, timestamp: new Date(t).toISOString(), message: { role: "user", content: [{ type: "text", text: owner }] } });
		asksLines.push({ type: "message", id: a, parentId: i <= 80 ? u : parent, timestamp: new Date(t + 60_000).toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: asks[i] ?? `Step ${i} landed and tests pass.` }], usage: { input: 120, output: 40, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } });
		parent = a;
	}
	writeFileSync(join(asksRoot, "sess-asks.jsonl"), asksLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	// Add synthetic owner-facing questions to the long Session.
	const big = sessions?.big?.file;
	if (big) {
		const last = JSON.parse(readFileSync(big, "utf8").trimEnd().split("\n").at(-1)!);
		const tail = [
			"The selector holds across the last compaction.\n\nShould I keep the selector cache per Host or share it across Hosts?",
			"The pre-compaction receipts still load.\n\nMay I drop the pre-compaction receipt format now?",
			"Waiting for you to give the SSH alias of the second Host.",
			"The CI runner is out of disk. To unblock it, approve a larger runner.",
		];
		let t = Date.parse(last.timestamp), parent: string = last.id, out = "";
		tail.forEach((text, i) => {
			const u = `big-ask-u${i}`, a = `big-ask-a${i}`;
			// One owner turn opens the tail; a later owner turn would overtake the asks before it.
			if (i === 0) out += JSON.stringify({ type: "message", id: u, parentId: parent, timestamp: new Date(Math.min(t += 60_000, now)).toISOString(), message: { role: "user", content: [{ type: "text", text: "Continue with the selector work." }] } }) + "\n";
			out += JSON.stringify({ type: "message", id: a, parentId: i === 0 ? u : parent, timestamp: new Date(Math.min(t += 30_000, now)).toISOString(), message: { role: "assistant", model: "claude-opus-5-5", provider: "anthropic", stopReason: "stop", content: [{ type: "text", text }], usage: { input: 120, output: 40, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } }) + "\n";
			parent = a;
		});
		appendFileSync(big, out);
	}
 // Offline side-ask and Arc answers use the same subprocess transport.
 writeFileSync(join(dir, "cos-model.cjs"), `let input = ""; process.stdin.on("data", d => input += d).on("end", () => {
  require("node:fs").appendFileSync(${JSON.stringify(join(dir, "ask-calls.jsonl"))}, JSON.stringify({kind:"other"}) + "\\n");
  let p; try { p = JSON.parse(input.split("\\nAnswer rejected:")[0]); } catch { console.log("Synthetic selected evidence answer."); return; }
  const items = p.rarebits || [], first = items[0], last = items.at(-1);
  if (!first) { console.log("{}"); return; }
  const claim = (i, text) => ({text, cites:[{id:i.id, quote:i.text.slice(0,120)}]});
  const open = p.previous?.chapters.find(c => c.closed === false);
  console.log(JSON.stringify({goal:claim(first,"Continue the agreed work."),now:claim(last,"The agent reports progress."),chapters:[{firstId:open?.firstId || first.id,label:"Reviewing the reported progress",closed:false,summary:{scope:claim(first,"Review the current work."),bullets:[claim(last,"The agent reported new evidence.")]}}],points:[]}));
 });`);
 return "";
}

/** Seed through the public Build path. The demo disables automatic triggers; arc-v2-triggers owns their proof. */
export async function seedDemoArcs(port: number, token: string, ids: string[]) {
 for (const threadId of ids) await new Promise<void>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${token}` } });
  let value: ArcValue | undefined, requested = false, ended = false;
  const finish = (error?: Error) => { if (ended) return; ended = true; clearTimeout(timer); ws.close(); error ? reject(error) : resolve(); };
  const timer = setTimeout(() => finish(new Error(`Demo Arc did not build: ${threadId}`)), 20_000);
  ws.on("error", finish);
  ws.on("open", () => ws.send(JSON.stringify({ t: "sub", sid: 1, host: "devbox", topic: { kind: "view", view: "arc", threadId } })));
  ws.on("message", data => {
   const frame = JSON.parse(String(data));
   if (frame.t === "res" && !frame.ok) { finish(new Error(frame.error.message)); return; }
   if (frame.sid !== 1) return;
   if (frame.t === "snap") value = frame.value;
   else if (frame.t === "ops" && value) value = applyImmutable(value, frame.ops);
   if (value?.receipt) { finish(); return; }
   if (value?.status?.state === "failed") { finish(new Error(value.status.error?.message ?? "Demo Arc failed")); return; }
   if (!requested && value?.series?.end) {
    requested = true;
    ws.send(JSON.stringify({ t: "req", id: 1, host: "devbox", op: "view.arc.build", args: { threadId } }));
   }
  });
 });
}
