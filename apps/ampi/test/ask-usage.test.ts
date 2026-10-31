import "./bound.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ModelPurpose, resolveHelperModel, useHubConfig } from "../src/hub/helper-models.ts";
import { piModelRegistry } from "../src/pi/model-registry.ts";
import { cosDemo } from "../scripts/demo/cos.ts";
import { ask } from "../src/pi/ask.ts";
import type { Chunk } from "../src/pi/views/cos-arc-chunks.ts";
import { buildArc, buildLog, cosArc, type ArcValue } from "../src/pi/views/cos-arc.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";
import { HELPER_MODELS } from "./pi-host-fixtures.ts";

useHubConfig(undefined, HELPER_MODELS);

// Cache read and write tokens survive the Pi JSON reply, the Build log, and the estimate's last-Build figure.
// A fake `pi --mode json` answers as the requested model, with the offline demo model's text and a cached-prompt usage record.

const root = mkdtempSync(join(tmpdir(), "ampi-ask-usage-"));
cosDemo({ dir: root, agentDir: join(root, "agent"), now: Date.now(), sessions: {} });
const USAGE = { input: 3, output: 50, cacheRead: 12_000, cacheWrite: 800, totalTokens: 12_853, cost: { total: 0.02 } };
const fakePi = join(root, "fake-pi");
writeFileSync(fakePi, `#!${process.execPath}
if (process.argv.includes("--list-models")) { console.log("provider model context\\nanthropic claude-haiku-5-5 1M\\nanthropic claude-sonnet-5-5 1M"); process.exit(0); }
const { execFileSync } = require("node:child_process");
const text = execFileSync(process.execPath, [${JSON.stringify(join(root, "cos-model.cjs"))}], { input: require("node:fs").readFileSync(0) }).toString().trim();
const arg = (flag) => { const at = process.argv.indexOf(flag); return at > 0 ? process.argv[at + 1] : undefined; };
const [provider, model] = arg("--provider") ? [arg("--provider"), arg("--model")] : arg("--model") ? arg("--model").split("/") : ["fake", "cached"];
const message = { role: "assistant", content: [{ type: "text", text }], provider, model, stopReason: "stop", usage: ${JSON.stringify(USAGE)} };
console.log(JSON.stringify({ type: "message_end", message }));
`);
chmodSync(fakePi, 0o755);

const T = Date.parse("2026-10-19T00:00:00.000Z");
const chunks: Chunk[] = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, index: i, hash: `h${i}`, startAt: new Date(T + i * 60_000).toISOString(), endAt: new Date(T + i * 60_000 + 30_000).toISOString(), firstEntryId: `u${i}`, lastEntryId: `a${i}`, firstAsk: `Step ${i}`, lastOwnerEntryId: `u${i}`, ownerTurns: 1, entries: 2, toolCalls: 0, where: null, idleBeforeMs: null, compactionEntryId: null }));
const session = { threadId: "pi:sess-a", ref: "devbox/pi:sess-a", sourceVersion: "v1",
	summary: { cwd: "/work/demo", live: true, activity: "idle", queued: 0 },
	data: { arc: { chunks, inputChars: 4000, shortenedChunks: 0, excludedEntries: 0 }, rarebit: { count: 16, fingerprint: "f".repeat(64) }, timeline: { stopped: true, marks: [] } },
	rarebits: () => ({ items: [], more: false, sourceVersion: "v1" }),
	arcEvidence: (ids: string[]) => new Map(ids.map((id) => { const i = id.slice(1); return [id, `[u${i}] USER: Run step ${i}.\n[a${i}] AGENT: Step ${i} landed and tests pass.`]; })),
	entryTimes: (ids: string[]) => new Map(ids.map((id) => [id, T + Number(id.slice(1)) * 60_000])) } as unknown as PiViewSession;

test("ask usage: the Pi JSON reply keeps cache read and write tokens", async () => {
	process.env.PI_BIN = fakePi;
	const answer = await ask({ system: "Answer.", prompt: "LABEL_BATCH\n[]" });
	assert.equal(answer.model, "fake/cached");
	assert.deepEqual(answer.usage, { input: 3, output: 50, cacheRead: 12_000, cacheWrite: 800, cost: 0.02 });
});

test("ask usage: a Build log record and the estimate's last Build count cached prompt tokens", async () => {
	process.env.PI_BIN = fakePi;
	const dir = join(root, "build"); mkdirSync(dir, { recursive: true });
	const ctx = { host: "devbox", stateDir: () => dir, session: () => session, lease: () => () => {}, invalidate() {}, snapshot: <T>(read: () => T) => read(), model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o, piModelRegistry),
		ask: (req: Parameters<PiViewContext["ask"]>[0]) => ask(req) } satisfies Partial<PiViewContext> as unknown as PiViewContext;
	buildArc(ctx, session);
	let value: ArcValue | undefined;
	for (let i = 0; i < 500 && (value = cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: session.threadId }) as ArcValue).job?.state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
	const run = buildLog(ctx, session.threadId).at(-1)!;
	assert.equal(run.state, "done", run.error ?? "");
	const n = run.calls;
	assert.ok(n >= 3, `a Build makes several calls (${n})`);
	const { cost, ...tokens } = run.usage;
	assert.deepEqual(tokens, { input: 3 * n, output: 50 * n, cacheRead: 12_000 * n, cacheWrite: 800 * n });
	assert.ok(Math.abs((cost ?? 0) - 0.02 * n) < 1e-9, `cost ${cost}`);
	assert.equal(value!.buildEstimate.lastInputTokens, (3 + 12_000 + 800) * n, "the estimate compares against every prompt token, cached or not");
});

test("ask usage: a Build log record from before cache tracking reads its cache fields as 0", () => {
	const dir = join(root, "legacy"); mkdirSync(dir, { recursive: true });
	const ctx = { host: "devbox", stateDir: () => dir } as unknown as PiViewContext;
	writeFileSync(join(dir, `${createHash("sha256").update("pi:legacy").digest("hex")}.builds.json`), JSON.stringify([{ trigger: "auto", startedAt: "2026-10-18T00:00:00.000Z", endedAt: "2026-10-18T00:01:00.000Z", state: "done", calls: 3, model: null, usage: { input: 9, output: 70, cost: 0.03 } }]));
	assert.deepEqual(buildLog(ctx, "pi:legacy")[0]!.usage, { input: 9, output: 70, cacheRead: 0, cacheWrite: 0, cost: 0.03 });
});
