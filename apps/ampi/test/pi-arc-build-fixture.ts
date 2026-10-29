import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosDemo } from "../scripts/demo/cos.ts";
import type { DemoContext } from "../scripts/demo/index.ts";
import { useHubConfig, type ModelPurpose, resolveHelperModel } from "../src/hub/helper-models.ts";
import { ask } from "../src/pi/ask.ts";
import type { Chunk } from "../src/pi/views/cos-arc-chunks.ts";
import { buildArc, cosArc, type ArcValue } from "../src/pi/views/cos-arc.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";

// Build arc through the real ask runner and the offline demo model, with a fake view context that counts calls in
// flight and delays answers so that they complete out of order.

export const root = mkdtempSync(join(tmpdir(), "ampi-arc-build-"));
// Every helper model is explicit; tests that need another set write their own hub.json, then return to this one.
export const MODELS = { arcLabels: "anthropic/claude-haiku-5-5", arcSynthesis: "anthropic/claude-sonnet-5-5", rarebitAsk: "anthropic/claude-sonnet-5-5" };
export const HUB = join(root, "models-hub.json");
writeFileSync(HUB, JSON.stringify({ hosts: [], models: MODELS }));
useHubConfig(HUB);
cosDemo({ dir: root, agentDir: join(root, "agent") } as DemoContext);
export const model = [process.execPath, join(root, "cos-model.cjs")];
export const T = Date.parse("2026-10-19T00:00:00.000Z");
// 20 chunks: four label batches of six, then one step-2 call.
export const chunks: Chunk[] = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, index: i, hash: `h${i}`, startAt: new Date(T + i * 60_000).toISOString(), endAt: new Date(T + i * 60_000 + 30_000).toISOString(), firstEntryId: `u${i}`, lastEntryId: `a${i}`, firstAsk: `Step ${i}`, lastOwnerEntryId: `u${i}`, ownerTurns: 1, entries: 2, toolCalls: i % 3, where: null, idleBeforeMs: null, compactionEntryId: null }));
export const session = { threadId: "pi:sess-a", ref: "devbox/pi:sess-a", sourceVersion: "v1", summary: { cwd: "/work/demo" }, data: { arc: { chunks }, rarebit: { count: 40, fingerprint: "f".repeat(64) }, timeline: { stopped: true, marks: [] } },
	arcEvidence: (ids: string[]) => new Map(ids.map((id) => { const i = id.slice(1); return [id, `[u${i}] USER: Run step ${i}.\n[a${i}] AGENT: Step ${i} landed and tests pass.`]; })),
	entryTimes: (ids: string[]) => new Map(ids.map((id) => [id, T + Number(id.slice(1)) * 60_000])),
	// Two Rarebit pages, newest first, cut at 8 KiB unless full text is asked for. Stop a3 asks after 9000 chars.
	rarebits(this: { sourceVersion: string }, before?: string, fullText?: boolean) {
		const page = (before ? chunks.slice(0, 10) : chunks.slice(10)).flatMap((c) => { const i = c.id.slice(1); return [
			{ id: `u${i}`, kind: "user", t: null, text: `Run step ${i}.` },
			{ id: `a${i}`, kind: "stop", t: null, text: i === "3" ? `Step 3 landed and tests pass.\n\n${"x".repeat(9000)}\n\nShould I keep step 3 behind a flag?` : `Step ${i} landed and tests pass.` }]; });
		return { items: page.map((item) => (fullText ? item : { ...item, text: item.text.slice(0, 8192) })), more: !before, sourceVersion: this.sourceVersion };
	} } as unknown as PiViewSession;

export type Run = { inFlight: number; maxInFlight: number; started: number; startedAfterFailure: number; failed: boolean };
export type Req = Parameters<PiViewContext["ask"]>[0];
export function context(name: string, delay: (call: number) => number, fail?: (call: number, req: Req) => boolean, edit?: (call: number, req: Req, text: string) => string) {
	const run: Run = { inFlight: 0, maxInFlight: 0, started: 0, startedAfterFailure: 0, failed: false };
	const dir = join(root, name); mkdirSync(dir, { recursive: true });
	const ctx = { host: "devbox", stateDir: () => dir, session: () => session, lease: () => () => {}, invalidate() {}, snapshot: <T>(read: () => T) => read(), model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o),
		async ask(req: Parameters<PiViewContext["ask"]>[0]) {
			const call = run.started++;
			if (run.failed) run.startedAfterFailure++;
			run.inFlight++; run.maxInFlight = Math.max(run.maxInFlight, run.inFlight);
			try {
				await new Promise((r) => setTimeout(r, delay(call)));
				if (fail?.(call, req)) { run.failed = true; throw Object.assign(new Error("model_error: synthetic failure"), { code: "model_error" }); }
				const answer = await ask(req, model);
				return edit ? { ...answer, text: edit(call, req, answer.text) } : answer;
			} finally { run.inFlight--; }
		} } as unknown as PiViewContext;
	return { ctx, run, dir };
}
export async function build(ctx: PiViewContext, limit?: number) {
	buildArc(ctx, session, {}, { limit });
	for (let i = 0; i < 400; i++) {
		const v = cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: session.threadId }) as ArcValue;
		if (v.job?.state !== "running") return v;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("Build arc did not finish");
}
