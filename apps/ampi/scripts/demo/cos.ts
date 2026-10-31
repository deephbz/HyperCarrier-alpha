import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOSED_CHUNKS_HEADER } from "../../src/pi/views/cos-arc-prompts.ts";
import type { DemoContext } from "./index.ts";

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
	// One long Session whose agent stops ask the owner in the phrasings the Needs-you rule finds: a restated ask, a
	// for-you list, and an ask the owner answers. The owner stops writing after step 80, so the blocker and the restated
	// ask stay open; the asks at steps 40 and 60 are answered or overtaken by later owner turns. It spans more than
	// 20 hours, so the Arcs list shows it.
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
	// The big Session is live and idle, so it builds automatically at hub start. Its last stops ask one open ask of each
	// kind (the demo model rotates kinds by candidate order), so its automatic Arc head fills Needs you.
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
	// Real ctx.ask transport, offline answer. Touch <DEMO_DIR>/cos-no-model to exercise a missing model, and
	// <DEMO_DIR>/cos-empty-tree for a step-2 answer whose tier-2 tree has nothing in it.
	writeFileSync(join(dir, "cos-model.cjs"), `const fs = require('node:fs');
if (fs.existsSync(${JSON.stringify(join(dir, "cos-no-model"))})) { console.error('No model available in this synthetic demo. Remove cos-no-model to enable the offline model.'); process.exit(2); }
let input = ''; process.stdin.on('data', d => input += d).on('end', () => {
  // A retry appends its note to the message; the demo answers the data before it.
  input = input.split('\\n\\nYour previous reply was invalid')[0];
  fs.appendFileSync(${JSON.stringify(join(dir, "ask-calls.jsonl"))}, JSON.stringify({ kind: input.includes('Write the re-entry recap.') ? 'recap' : 'other' }) + '\\n');
  let p; try { p = JSON.parse(input); } catch { setTimeout(() => { if (/Question: "fail/i.test(input)) process.exit(3); console.log(input.includes('Write the re-entry recap.') ? 'The reader work has progressed; review the reported tests and decide the next step.' : 'The agent reports tests passing and changes to reader.ts. This is selected prose, not independent verification.'); }, 600); return; }
  // Step 2 sends the closed chunks in the system text (AMPI_ASK_SYSTEM_FILE); the message holds the open chunk.
  const sys = process.env.AMPI_ASK_SYSTEM_FILE && fs.existsSync(process.env.AMPI_ASK_SYSTEM_FILE) ? fs.readFileSync(process.env.AMPI_ASK_SYSTEM_FILE, 'utf8') : '';
  const closedAt = sys.indexOf(${JSON.stringify(CLOSED_CHUNKS_HEADER)});
  if (p && p.arcs && closedAt >= 0) p.arcs = [...JSON.parse(sys.slice(closedAt + ${JSON.stringify(CLOSED_CHUNKS_HEADER)}.length)), ...p.arcs];
  const names = ['Session reader', 'One GUI', 'Verification'];
  // Step 2 answers tier 1 from the chunk labels and tier 2 from the evidence, in one object.
  const project = (c) => c.label?.project ?? 'Unlabelled';
  const tier1 = p.arcs && { headline: 'Synthetic demo: reader → GUI → verification', projects: [...new Set(p.arcs.map(project))].map(name => ({ name, summary: 'Synthetic fixture, not a real model assessment.', status: 'paused' })), transitions: p.arcs.filter((c,i,a) => i && project(c) !== project(a[i-1])).map(c => ({ chunk: c.chunk, kind: 'new_project', from: 'Previous stage', to: project(c), why: 'Synthetic demonstration transition.' })) };
  if (p.arcs && fs.existsSync(${JSON.stringify(join(dir, "cos-empty-tree"))})) { console.log(JSON.stringify({ ...tier1, asks: [], threads: [], unassigned: {} })); return; }
  if (p.arcs) {
    // Tier 2: cite real entry IDs from the supplied evidence and quote their first words. Every candidate becomes an
    // ask of a rotating kind; an ask whose next owner turn starts with "Yes" is answered by it. Enough leaves to fold.
    const text = p.arcs.map(a => a.rarebitEvidence).join('\\n'), said = new Map(), ids = (role) => [...text.matchAll(new RegExp('^\\\\[([^\\\\]]+)\\\\] ' + role + ': (.*)$', 'gm'))].map(m => (said.set(m[1], m[2]), m[1]));
    const u = ids('USER'), a = ids('AGENT'), at = (list, i) => list[(i % list.length + list.length) % list.length];
    const leaf = (t, list, i) => { const id = at(list, i); return { text: t, citations: [id], quote: (said.get(id) || '').replace(/…$/, '').split(' ').slice(0, 6).join(' ') }; };
    const kinds = ['decision', 'approval', 'input', 'blocker'], answered = (p.askCandidates || []).find(c => /^Yes/.test(said.get(c.ownerTurnsAfter[0]) || ''));
    const thread = (label, state, n) => ({ label, state, progress: [leaf(label + ': step ' + n + ' landed and tests pass', a, n), leaf(label + ': review notes applied', a, n + 1)], decisions: [leaf('Keep ' + label + ' behind the existing Host boundary', a, n + 2)], blockers: [] });
    console.log(JSON.stringify({ ...tier1,
      asks: (p.askCandidates || []).map((c, i) => ({ candidates: [c.id], text: c.text.replace(/[*?]/g, '').slice(0, 90), kind: kinds[i % 4], answeredBy: c === answered ? c.ownerTurnsAfter[0] : null })),
      threads: [
        { label: 'Session reader', state: 'active', progress: [leaf('Host-qualified records land in the reader', a, 3)], decisions: [leaf('Persist the Rarebit fingerprint in the receipt', u, 2)], blockers: [] },
        thread('One GUI', 'paused', 6), thread('Verification', 'active', 9), thread('Release notes', 'done', 12), thread('Telemetry', 'paused', 15), thread('Docs', 'done', 18)],
      unassigned: { progress: [leaf('Profiling of the derive worker started', a, 20)], decisions: [], blockers: [] },
    }));
    return;
  }
  console.log(JSON.stringify({ chunks: p.chunks.map(c => ({ chunk: c.chunk, project: names[Math.floor(Number(c.chunk.slice(1)) / 2) % 3], topic: 'Synthetic stage ' + (Number(c.chunk.slice(1)) + 1) + ': ' + names[Math.floor(Number(c.chunk.slice(1)) / 2) % 3] })) }));
});`);
	if (process.env.DEMO_ARC_NO_MODEL === "1") writeFileSync(join(dir, "cos-no-model"), "");
	return "";
}
