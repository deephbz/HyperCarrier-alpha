import "./bound.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { cosDemo } from "../scripts/demo/cos.ts";
import type { DemoContext } from "../scripts/demo/index.ts";
import { resolveHelperModel, useHubConfig, type ModelPurpose } from "../src/hub/helper-models.ts";
import { ask, askCwd, sweepAskScratch } from "../src/pi/ask.ts";
import type { Chunk } from "../src/pi/views/cos-arc-chunks.ts";
import { LABEL_SYSTEM, STEP2_SYSTEM } from "../src/pi/views/cos-arc-prompts.ts";
import { WARM_CACHE_GAP_MS } from "../src/pi/views/cos-arc-rules.ts";
import { arcClock, buildArc, buildLog, cosArc, type ArcValue } from "../src/pi/views/cos-arc.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";

// The step-2 prompt cache (arc-synth-cost): Pi caches the system block, so step 2 puts every closed chunk there and
// only the open chunk and the ask candidates in the message. The system text must stay byte-identical, Pi's own cwd
// section included, until a chunk closes or a closed chunk's label changes. A stub Pi records what it read; it hands
// the call to the offline demo model, so Builds run end to end.

const root = mkdtempSync(join(tmpdir(), "ampi-arc-cache-"));
// Every ask in this file runs under a private os.tmpdir(), so no test touches the hub's own fixed cwd.
const TMP = join(root, "tmp"); mkdirSync(TMP);
process.env.TMPDIR = TMP;
delete process.env.PI_CACHE_RETENTION;
const MODELS = { arcLabels: "anthropic/claude-haiku-5-5", arcSynthesis: "anthropic/claude-sonnet-5-5", rarebitRecap: "anthropic/claude-haiku-5-5", rarebitAsk: "anthropic/claude-sonnet-5-5" };
const HUB = join(root, "hub.json");
writeFileSync(HUB, JSON.stringify({ hosts: [], models: MODELS }));
useHubConfig(HUB);
cosDemo({ dir: root, agentDir: join(root, "agent") } as DemoContext);
const LOG = join(root, "pi-calls.jsonl"), FLAGS = join(root, "flags");
mkdirSync(FLAGS);
const flag = (name: string, on = true) => (on ? writeFileSync(join(FLAGS, name), "") : rmSync(join(FLAGS, name), { force: true }));

// Pi 1.3.0 reads --system-prompt from a file when the path exists and appends `<cwd>` as the last system section
// (core/system-prompt.js); the stub rebuilds that text, so the log shows the system block Pi would send.
const fakePi = join(root, "fake-pi");
writeFileSync(fakePi, `#!${process.execPath}
const fs = require("node:fs"), { execFileSync } = require("node:child_process"), path = require("node:path");
const arg = (f) => { const at = process.argv.indexOf(f); return at > 0 ? process.argv[at + 1] : undefined; };
const file = arg("--system-prompt"), isFile = !!file && fs.existsSync(file), sys = isFile ? fs.readFileSync(file, "utf8") : file ?? "";
const on = (n) => fs.existsSync(path.join(${JSON.stringify(FLAGS)}, n));
const purpose = sys.startsWith("You label") ? "labels" : "synthesis";
const input = fs.readFileSync(0, "utf8");
if (on("fail")) { fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ purpose: "failed", file }) + "\\n"); process.exit(1); }
let text = execFileSync(process.execPath, [${JSON.stringify(join(root, "cos-model.cjs"))}], { input, env: { ...process.env, AMPI_ASK_SYSTEM_FILE: isFile ? file : "" } }).toString().trim();
if (purpose === "labels" && on("relabel")) text = text.replace(/"topic":"Synthetic stage 7:/, '"topic":"Relabelled stage 7:');
if (purpose === "synthesis" && on("bad-once")) { fs.rmSync(path.join(${JSON.stringify(FLAGS)}, "bad-once")); text = "{}"; }
const long = process.env.PI_CACHE_RETENTION === "long", stripped = on("strip-ttl");
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ purpose, isFile, file, bytes: isFile ? fs.statSync(file).size : null, fileMode: isFile ? fs.statSync(file).mode & 0o777 : null, dirMode: isFile ? fs.statSync(path.dirname(file)).mode & 0o777 : null,
  system: sys + "\\n\\n<cwd>\\n" + process.cwd() + "\\n</cwd>", cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), retention: process.env.PI_CACHE_RETENTION ?? null, prompt: input }) + "\\n");
const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 1000, ...(long && !stripped ? { cacheWrite1h: 1000 } : {}), cost: { total: 0.01 } };
const [provider, model] = arg("--provider") ? [arg("--provider"), arg("--model")] : ["fake", "model"];
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], provider, model, stopReason: "stop", usage } }));
`);
chmodSync(fakePi, 0o755);
process.env.PI_BIN = fakePi;
type Call = { purpose: string; isFile: boolean; file: string; bytes: number | null; fileMode: number | null; dirMode: number | null; system: string; cwd: string; cwdEntries: string[]; retention: string | null; prompt: string };
const calls = (): Call[] => existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const reset = () => rmSync(LOG, { force: true });
const STABLE = () => join(TMP, `ampi-ask-cwd-${process.getuid!()}`);

test("ask cache: two calls share one fixed cwd under os.tmpdir() that names no $HOME, username or per-call part; the system prompt reaches Pi as a private file that is gone after the call (failure: a new mkdtemp cwd per call changed Pi's system block every time)", async () => {
	reset();
	const system = `Answer.\n${"é".repeat(3000)}`;
	await ask({ system, prompt: "LABEL_BATCH\n[]" });
	await ask({ system, prompt: "LABEL_BATCH\n[]" });
	const [a, b] = calls();
	assert.equal(a!.cwd, realpathSync(STABLE()), "the fixed cwd");
	assert.equal(b!.cwd, a!.cwd, "the same cwd on the next call");
	assert.equal(a!.system, b!.system, "byte-identical system text, Pi's cwd section included");
	for (const part of [homedir(), userInfo().username, "/work/demo"]) assert.ok(!a!.cwd.includes(part), `the cwd names no ${part}`);
	assert.deepEqual(a!.cwdEntries, [], "Pi runs in an empty directory, so it loads no AGENTS.md");
	assert.equal(lstatSync(STABLE()).mode & 0o777, 0o700);
	assert.ok(a!.isFile, "the system prompt goes to Pi by path");
	assert.equal(a!.bytes, Buffer.byteLength(system), "Pi read every byte");
	assert.equal(a!.fileMode! & 0o077, 0, "only the owner can read the prompt file");
	assert.equal(a!.dirMode, 0o700, "nor list its directory");
	assert.ok(!a!.file.startsWith(STABLE()), "the prompt file lives outside the fixed cwd");
	assert.ok(!existsSync(a!.file) && !existsSync(b!.file), "each prompt file is gone after its call");
});

test("ask cache: a call that fails still removes its prompt directory, and its error names no prompt path (failure: a failed call left prompt text in os.tmpdir())", async () => {
	reset();
	flag("fail");
	try {
		await assert.rejects(ask({ system: "Answer.", prompt: "LABEL_BATCH\n[]" }), (e: Error) => !/ampi-ask-|system\.txt/.test(e.message));
	} finally { flag("fail", false); }
	const [failed] = calls();
	assert.equal(failed!.purpose, "failed");
	assert.ok(!existsSync(dirname(failed!.file)), "the per-call directory is gone");
});

test("ask cache: a fixed cwd that is not empty, or is a symlink, falls back to a private per-call directory and is left in place (failure: Pi ran in a directory it could read context from)", async () => {
	reset();
	const stable = STABLE();
	writeFileSync(join(stable, "AGENTS.md"), "planted");
	assert.equal(askCwd(), null, "a non-empty directory is refused");
	await ask({ system: "Answer.", prompt: "LABEL_BATCH\n[]" });
	assert.notEqual(calls()[0]!.cwd, realpathSync(stable), "the call ran elsewhere");
	assert.ok(existsSync(join(stable, "AGENTS.md")), "the refused directory is not deleted");
	rmSync(stable, { recursive: true });
	const elsewhere = mkdtempSync(join(root, "target-"));
	symlinkSync(elsewhere, stable);
	assert.equal(askCwd(), null, "a symlink is refused");
	await ask({ system: "Answer.", prompt: "LABEL_BATCH\n[]" });
	assert.ok(lstatSync(stable).isSymbolicLink(), "the symlink is left in place");
	assert.notEqual(calls()[1]!.cwd, realpathSync(elsewhere));
	rmSync(stable);
	assert.equal(askCwd(), stable, "a missing directory is created again");
});

test("ask cache: cache \"long\" sets PI_CACHE_RETENTION=long for that call only; the default sets nothing, and a reported 1 h write is kept apart (failure: the 5-min cache expired before the next Build)", async () => {
	reset();
	await ask({ system: "Answer.", prompt: "LABEL_BATCH\n[]", cache: "long" });
	const plain = await ask({ system: "Answer.", prompt: "LABEL_BATCH\n[]" });
	assert.deepEqual(calls().map((c) => c.retention), ["long", null]);
	assert.equal(process.env.PI_CACHE_RETENTION, undefined, "the hub's own env is unchanged");
	assert.equal(plain.usage?.cacheWrite1h, undefined, "a 5-min write reports no 1 h part");
	const long = await ask({ system: "Answer.", prompt: "LABEL_BATCH\n[]", cache: "long" });
	assert.equal(long.usage?.cacheWrite1h, 1000);
});

test("ask cache: the start sweep removes only this user's stale per-call prompt directories (failure: a crash left prompt text in os.tmpdir())", () => {
	const old = Date.now() / 1000 - 3600;
	const made = (name: string, age = old) => { const p = join(TMP, name); mkdirSync(p); writeFileSync(join(p, "system.txt"), "x"); utimesSync(p, age, age); return p; };
	const stale = made("ampi-ask-Ab12Cd"), fresh = made("ampi-ask-Ef34Gh", Date.now() / 1000), other = made("other-Ab12Cd");
	const link = join(TMP, "ampi-ask-Zz99Yy"); symlinkSync(other, link);
	askCwd();
	utimesSync(STABLE(), old, old);
	sweepAskScratch();
	assert.ok(!existsSync(stale), "a stale prompt directory goes");
	assert.ok(existsSync(fresh), "a running call's directory stays");
	assert.ok(existsSync(other) && lstatSync(link).isSymbolicLink(), "another name and a symlink stay");
	assert.ok(existsSync(STABLE()), "the fixed cwd stays");
});

// A Session of `n` chunks; `open` varies the last chunk's text, and `extra` adds owner turns to it.
const T = Date.parse("2026-10-19T00:00:00.000Z");
function session(n: number, { open = "", extra = 0, hashes = {} as Record<string, string>, live = true } = {}): PiViewSession {
	const chunks: Chunk[] = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, index: i, hash: hashes[`c${i}`] ?? (i === n - 1 ? `h${i}${open}` : `h${i}`), startAt: new Date(T + i * 60_000).toISOString(), endAt: new Date(T + i * 60_000 + 30_000).toISOString(),
		firstEntryId: `u${i}`, lastEntryId: `a${i}`, firstAsk: null, lastOwnerEntryId: `u${i}`, ownerTurns: 1, entries: 2, toolCalls: 0, where: null, idleBeforeMs: null, compactionEntryId: null }));
	const lines = (i: number) => [`[u${i}] USER: Run step ${i}.`, ...(i === n - 1 ? Array.from({ length: extra }, (_, k) => `[x${k}] USER: Also check ${k}.`) : []), `[a${i}] AGENT: Step ${i} landed and tests pass.${i === n - 1 ? open : ""}`];
	const items = chunks.flatMap((c, i) => [{ id: `u${i}`, kind: "user", t: null, text: `Run step ${i}.` }, ...(i === n - 1 ? Array.from({ length: extra }, (_, k) => ({ id: `x${k}`, kind: "user", t: null, text: `Also check ${k}.` })) : []),
		{ id: `a${i}`, kind: "stop", t: null, text: i === 3 ? "Should I keep step 3 behind a flag?" : `Step ${i} landed and tests pass.${i === n - 1 ? open : ""}` }]);
	return { threadId: "pi:sess-c", ref: "devbox/pi:sess-c", sourceVersion: `v${n}${open}${extra}`, summary: { cwd: "/work/demo", live, activity: "idle", queued: 0 },
		data: { arc: { chunks, inputChars: 4000, shortenedChunks: 0, excludedEntries: 0 }, rarebit: { count: items.length, fingerprint: `${n}${open}${extra}`.padEnd(64, "f") }, timeline: { stopped: true, marks: [] } },
		arcEvidence: (ids: string[]) => new Map(ids.map((id) => [id, lines(Number(id.slice(1))).join("\n")])),
		entryTimes: (ids: string[]) => new Map(ids.map((id) => [id, T + Number(id.slice(1).replace(/\D/g, "")) * 60_000])),
		rarebits: () => ({ items, more: false, sourceVersion: `v${n}${open}${extra}` }) } as unknown as PiViewSession;
}
type Req = Parameters<PiViewContext["ask"]>[0];
function context(dir: string, s: () => PiViewSession, reqs: Req[] = []) {
	mkdirSync(dir, { recursive: true });
	return { host: "devbox", stateDir: () => dir, session: () => s(), lease: () => () => {}, invalidate() {}, snapshot: <T>(read: () => T) => read(),
		model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o), ask: (req: Req) => { reqs.push(req); return ask(req); } } as unknown as PiViewContext;
}
async function build(ctx: PiViewContext, s: PiViewSession, opts: Parameters<typeof buildArc>[3] = {}) {
	buildArc(ctx, s, {}, opts);
	for (let i = 0; i < 400; i++) {
		const v = cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: s.threadId }) as ArcValue;
		if (v.job?.state !== "running") { assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? ""); return buildLog(ctx, s.threadId).at(-1)!; }
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("Build arc did not finish");
}
const synthesis = () => calls().filter((c) => c.purpose === "synthesis");
const lastSystem = () => synthesis().at(-1)!.system;

test("arc cache prefix: step 2 sends every closed chunk in the system text and only the open chunk and ask candidates in the message; the system text is byte-identical across Builds and a hub restart, and changes on a chunk close or a closed label change (failure: every Build wrote the whole prompt to the cache and read none)", async () => {
	reset();
	const dir = join(root, "prefix");
	let s = session(8);
	const ctx = context(dir, () => s);
	await build(ctx, s);
	const first = synthesis().at(-1)!;
	assert.ok(first.system.startsWith(STEP2_SYSTEM), "the instructions come first");
	assert.match(first.system, /"chunk":"c6"/, "a closed chunk is in the system text");
	assert.match(first.system, /\[a6\] AGENT: Step 6 landed/, "with its Rarebit evidence");
	assert.doesNotMatch(first.system, /"chunk":"c7"/, "the open chunk is not");
	assert.doesNotMatch(first.system, /"askCandidates"|\/work\/demo/, "nor the ask candidates or the Session cwd");
	for (const part of [homedir(), userInfo().username]) assert.ok(!first.system.includes(part), `the system text names no ${part}`);
	const message = JSON.parse(first.prompt) as { cwd: string; askCandidates: unknown[]; arcs: { chunk: string }[] };
	assert.deepEqual(message.arcs.map((a) => a.chunk), ["c7"], "the message holds the open chunk only");
	assert.equal(message.cwd, "/work/demo");
	assert.ok(message.askCandidates.length, "and the ask candidates");

	s = session(8, { open: " Then more." });
	await build(ctx, s);
	assert.equal(lastSystem(), first.system, "a grown open chunk keeps the system text");
	assert.match(synthesis().at(-1)!.prompt, /Then more\./);

	const again = context(dir, () => s);
	await build(again, s);
	assert.equal(lastSystem(), first.system, "a new hub on the same state sends the same bytes");

	s = session(9, { hashes: { c7: "h7 Then more." } });
	await build(again, s);
	assert.notEqual(lastSystem(), first.system, "a closed chunk changes the system text");
	const closed = lastSystem();

	flag("relabel");
	s = session(9, { hashes: { c6: "h6-new", c7: "h7 Then more." } });
	await build(again, s);
	flag("relabel", false);
	assert.match(lastSystem(), /Relabelled stage 7/, "the new closed label is sent");
	assert.notEqual(lastSystem(), closed, "a closed chunk's new label changes the system text");
});

test("arc cache prefix: with arcEvidence \"labels\", a new owner turn or a same-version relabel of the open chunk keeps the system text; a retry asks again in the message, not the system text (failure: the retry wrote a second cache no Build reads)", async () => {
	const file = join(root, "labels-hub.json");
	writeFileSync(file, JSON.stringify({ hosts: [], models: MODELS, arcEvidence: "labels" }));
	useHubConfig(file);
	try {
		reset();
		let s = session(6);
		const ctx = context(join(root, "labels"), () => s);
		await build(ctx, s);
		const first = lastSystem();
		s = session(6, { extra: 2, open: " Relabel me." });
		await build(ctx, s);
		assert.equal(lastSystem(), first, "the open chunk's owner turns and label stay out of the system text");
		assert.match(synthesis().at(-1)!.prompt, /Also check 1\./);
		flag("bad-once");
		s = session(6, { extra: 3, open: " Relabel me." });
		await build(ctx, s);
		const [bad, retry] = synthesis().slice(-2);
		assert.equal(retry!.system, bad!.system, "the retry keeps the cached system text");
		assert.equal(retry!.system, first);
		assert.match(retry!.prompt, /Your previous reply was invalid/, "the retry note is in the message");
	} finally { useHubConfig(HUB); flag("bad-once", false); }
});

test("arc cache retention: an automatic Build of a live Session within 55 min of the last Build asks for the 1 h cache; manual, upgrade, not live, a longer gap and labels keep the 5-min default, and the record says which (failure: a cold Build paid the 2x write)", async () => {
	reset();
	let s = session(5);
	const ctx = context(join(root, "retention"), () => s);
	const first = await build(ctx, s, { trigger: "auto" });
	assert.equal(first.cache, undefined, "no earlier Build: no hint that another comes soon");
	s = session(5, { open: " a" });
	const warm = await build(ctx, s, { trigger: "auto" });
	assert.equal(warm.cache, "long");
	assert.deepEqual(calls().filter((c) => c.purpose === "synthesis").map((c) => c.retention), [null, "long"]);
	assert.ok(calls().filter((c) => c.purpose === "labels").every((c) => c.retention === null), "labels never ask for the 1 h cache");
	assert.equal(warm.usageByPurpose?.synthesis.cacheWrite1h, 1000, "the 1 h write is recorded");
	s = session(5, { open: " b" });
	assert.equal((await build(ctx, s, { trigger: "manual" })).cache, undefined, "manual");
	s = session(5, { open: " c" });
	assert.equal((await build(ctx, s, { trigger: "auto", cause: "rebuilt: the Arc format changed" })).cache, undefined, "upgrade");
	s = session(5, { open: " d", live: false });
	assert.equal((await build(ctx, s, { trigger: "auto" })).cache, undefined, "not live");
	const now = arcClock.now;
	arcClock.now = () => now() + WARM_CACHE_GAP_MS + 60_000;
	try {
		s = session(5, { open: " e" });
		assert.equal((await build(ctx, s, { trigger: "auto" })).cache, undefined, "more than 55 min since the last Build ended");
	} finally { arcClock.now = now; }
});

test("arc cache retention: a provider that drops the 1 h ttl still completes the Build and records a 5-min write (failure: a gateway without ttl support broke Builds)", async () => {
	reset();
	flag("strip-ttl");
	try {
		let s = session(5);
		const ctx = context(join(root, "stripped"), () => s);
		await build(ctx, s, { trigger: "auto" });
		s = session(5, { open: " a" });
		const run = await build(ctx, s, { trigger: "auto" });
		assert.equal(run.cache, "long", "the Build asked for 1 h");
		assert.equal(run.usageByPurpose?.synthesis.cacheWrite, 1000);
		assert.equal(run.usageByPurpose?.synthesis.cacheWrite1h, undefined, "the record shows what the provider wrote");
	} finally { flag("strip-ttl", false); }
});
