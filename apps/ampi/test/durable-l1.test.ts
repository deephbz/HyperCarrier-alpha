import "./bound.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { runDaemon } from "../src/node/daemon.ts";
// @ts-ignore: shared reader is plain ESM.
import { createReaderService } from "../../trace-analytics/src/sources/durable-wire.mjs";
import { teamPlugin } from "../src/plugins/team.ts";
import { Hub } from "../src/hub/hub.ts";
import { Browser } from "./helpers.ts";
import { ALL_COVERS, HISTORY_COVERS, historySpend, spendSuffix } from "../src/shared/spend.ts";
import { control, fixture } from "./pi-fixtures.ts";
import { href, parseRef, parseRoute } from "../web/src/util.ts";

/** Normalize exact fixture identities only. Keep every field, array order, number, and unknown value. */
function normalize(value: any, aliases: Map<string, string>): any {
	if (typeof value === "string") return aliases.get(value) ?? value;
	if (Array.isArray(value)) return value.map((v) => normalize(v, aliases));
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [aliases.get(key) ?? key, normalize(value[key], aliases)]));
	return value;
}

const line = (value: unknown) => JSON.stringify(value) + "\n";
const at = "2026-10-24T00:00:00.000Z";

// L1 Pi-side skeleton. This does not assert durable parity or replace browser verification.
test("durable L1 skeleton: Pi owner scenario records frames, checkpoints, effects, and a negative control", { timeout: 20_000 }, async () => {
	const started = performance.now();
	const f = fixture();
	const proof = mkdtempSync(join(resolve(process.env.AMPI_DURABLE_PROOF ?? tmpdir()), "ampi-durable-l1-"));
	const frames: unknown[] = [];
	const checkpoints: { name: string; value: any }[] = [];
	const token = "c".repeat(64);
	const bin = join(f.dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\necho 'L1 refuses fallback Herdr' >&2\nexit 1\n", { mode: 0o755 });
	writeFileSync(f.sessionA,
		line({ type: "session", version: 3, id: "sess-a", timestamp: at, cwd: "/work" }) +
		line({ type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "List the synthetic files" }], timestamp: Date.parse(at) } }) +
		line({ type: "message", id: "a1", parentId: "u1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "The synthetic file is sample.txt." }], model: "synthetic", provider: "fixture", usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0.25 } }, timestamp: Date.parse(at) } }));
	const ctl = await control(f, f.sessionA, { queue: true });
	const hub = new Hub({ backend: "pi", hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: join(f.dir, "cache"),
		agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teams: false, controlStatusMs: 100 },
		env: { HOME: f.dir, PATH: `${bin}:${process.env.PATH ?? ""}`, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") },
	}] }, { token });
	let browser: Browser | undefined;
	let error: string | undefined;
	try {
		const port = await hub.listen(0);
		assert.ok(port < 7879 || port > 7895, "protected ports are forbidden");
		browser = await Browser.open(port, undefined, `ampi_k_${port}=${token}`);
		browser.ws.on("message", (data) => frames.push(JSON.parse(String(data))));
		await browser.when(() => browser!.hosts.some((h) => h.id === "devbox" && h.status === "connected"), 5000, "synthetic Pi Host");
		const threads = browser.sub("devbox", { kind: "threads" });
		await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true, 5000);
		const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
		const session = await browser.until<any>(thread, (v) => v.entries?.length === 2, 5000);
		assert.deepEqual(session.entries.map((entry: any) => entry.id), ["u1", "a1"]);
		assert.match(JSON.stringify(session.entries), /sample\.txt/);
		const list = await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.costUsd === 0.25 && v.threads["pi:sess-b"]?.live, 5000);
		assert.equal(list.threads["pi:sess-a"].live, true);
		checkpoints.push({ name: "overview", value: structuredClone(list) });
		checkpoints.push({ name: "session", value: structuredClone(session) });
		for (const [name, op, args] of [
			["history", "thread.history", { threadId: "pi:sess-a" }],
			["find", "thread.find", { threadId: "pi:sess-a", query: "synthetic" }],
			["citation", "thread.entry", { threadId: "pi:sess-a", entry: "a1" }],
		] as const) {
			const value = await browser.req("devbox", op, args);
			if (name === "history") assert.deepEqual(value.entries.map((entry: any) => entry.id), ["u1", "a1"]);
			if (name === "find") assert.deepEqual(value.hits.map((hit: any) => hit.ref), ["devbox/pi:sess-a#u1", "devbox/pi:sess-a#a1"]);
			if (name === "citation") {
				assert.equal(JSON.parse(value.text).id, "a1");
				assert.match(value.text, /sample\.txt/);
				assert.equal(value.more, false);
				assert.ok(value.next > 0 && value.version);
			}
			checkpoints.push({ name, value });
		}
		const admitted = await browser.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "Inspect sample.txt", whenBusy: "steer", requestId: "l1-input-1" });
		assert.equal(admitted.evidence, "admitted");
		assert.equal(ctl.submissions.length, 1);
		assert.equal(ctl.submissions[0]!.text, "Inspect sample.txt");
		assert.equal(ctl.submissions[0]!.deliverAs, "steer");
		checkpoints.push({ name: "submit", value: admitted });
		const aborted = await browser.req("devbox", "thread.abort", { threadId: "pi:sess-a" });
		assert.equal(aborted.evidence, "aborted");
		assert.equal(ctl.submissions[0]!.state, "returned");
		checkpoints.push({ name: "abort", value: aborted });
		assert.deepEqual(browser.gaps, [], "hub patch sequence has no gaps");
		assert.ok(frames.some((v: any) => v.t === "snap"));
		assert.ok(frames.some((v: any) => v.t === "res"));
		const aliases = new Map([[f.sessionA, "<session-a-path>"], [f.sessionB, "<session-b-path>"], ["pi:sess-a", "<thread-a>"], ["pi:sess-b", "<thread-b>"]]);
		const canonical = normalize(checkpoints, aliases);
		assert.deepEqual(canonical, normalize(structuredClone(checkpoints), aliases));
		const changed = structuredClone(checkpoints);
		changed.find((c) => c.name === "citation")!.value = { unexpected: "semantic mutation" };
		assert.throws(() => assert.deepEqual(canonical, normalize(changed, aliases)), assert.AssertionError, "semantic mutation must fail comparison");
		assert.notDeepEqual(normalize({ state: "idle" }, aliases), normalize({ state: "failed" }, aliases));
		writeFileSync(join(proof, "normalized.json"), JSON.stringify(canonical, null, 2) + "\n");
	} catch (e) {
		error = String(e);
		throw e;
	} finally {
		browser?.ws.terminate();
		await hub.close();
		await new Promise<void>((done) => ctl.close().once("close", done));
		const effects = { control: ctl.requests, submissions: ctl.submissions, herdr: f.herdrCalls() };
		writeFileSync(join(proof, "frames.jsonl"), frames.map(line).join(""));
		writeFileSync(join(proof, "checkpoints.json"), JSON.stringify(checkpoints, null, 2) + "\n");
		writeFileSync(join(proof, "effects.json"), JSON.stringify(effects, null, 2) + "\n");
		rmSync(f.dir, { recursive: true, force: true });
		const wallMs = Math.round(performance.now() - started);
		writeFileSync(join(proof, "receipt.json"), JSON.stringify({ schema: "ampi-durable-l1/1", backend: "pi", status: error ? "failed" : "passed", error, revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().split("\n"), wallMs, frames: frames.length, checkpoints: checkpoints.map((c) => c.name), frameSha256: createHash("sha256").update(frames.map(line).join("")).digest("hex"), sourceSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"), apiSpendUsd: 0, cleanup: "WebSocket terminated; hub closed; control listener closed; fixture removed", durableParity: "pending" }, null, 2) + "\n");
		console.log(`L1 Pi ${error ? "FAIL" : "PASS"}: ${wallMs} ms, ${frames.length} frames; proof ${proof}`);
	}
});

// Characterize the early node boundary. A completed capture can contain differences; parity is a separate verdict.
type L1Checkpoint = { name: string; value: any; frameEnd: number };
type L1Driver = {
	backend: "pi" | "durable"; browser: Browser; hub: Hub; threadId: string;
	frames: any[]; checkpoints: L1Checkpoint[]; identities: Map<string, string>; submissions: Map<string, string>;
	readiness?: { checkpoint: string; status: "settled" | "not-settled"; reason?: string; frameEnd: number }[];
	readerRange?: { upper: number | null; records: { id: number; kind: string }[] };
	arcCalls?: unknown[];
	citationRoute?: { ref: string; href: string; host: string; threadId: string; entry: string };
	readArcCalls(): unknown[];
	captureReaderRange?(): Promise<void>;
	prepareTeam(): Promise<void>;
	stop(): Promise<void>; effects(): unknown;
};
const seedPrompt = "List the synthetic files";
const seedAnswer = "The synthetic file is sample.txt.";
const busyPrompt = "Continue the inspection";

async function bounded<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
		})]);
	} finally { clearTimeout(timer!); }
}

async function attachBrowser(hub: Hub, frames: any[]): Promise<Browser> {
	const port = await hub.listen(0);
	assert.ok(port < 7879 || port > 7895, "protected ports are forbidden");
	const browser = await Browser.open(port, undefined, `ampi_k_${port}=${"d".repeat(64)}`);
	browser.ws.on("message", data => frames.push(JSON.parse(String(data))));
	await browser.when(() => browser.hosts.some(h => h.id === "devbox" && h.status === "connected"), 5000, "disposable host");
	return browser;
}

async function ownerScenario(driver: L1Driver) {
	const { browser, threadId } = driver;
	const record = (name: string, value: unknown) => driver.checkpoints.push({ name, value: structuredClone(value), frameEnd: driver.frames.length });
	const threads = browser.sub("devbox", { kind: "threads" });
	const list = await browser.until<any>(threads, v => !!v.threads[threadId]?.control && v.threads[threadId]?.preview === busyPrompt && !!v.threads[threadId]?.model, 5000);
	assert.equal(list.threads[threadId].live, true);
	record("overview", list);
	const thread = browser.sub("devbox", { kind: "thread", threadId });
	const session = await browser.until<any>(thread, v => v.entries?.some((e: any) => e.kind === "user" && e.text === busyPrompt), 5000);
	assert.ok(session.entries.some((e: any) => e.kind === "assistant" && e.blocks?.some((b: any) => b.text === seedAnswer)), "matched seed answer reaches the UI");
	record("session", session);
	for (const [name, content, whenBusy] of [
		["steer", "Inspect sample.txt", "steer"],
		["queue", "Check sample.txt", "followUp"],
	] as const) {
		const value = await bounded(browser.req("devbox", "thread.submit", { threadId, content, whenBusy, requestId: `l1-${name}` }), name);
		assert.ok(value.submission, `${name} returns a submission ID`);
		assert.ok(!driver.submissions.has(String(value.submission)), "each owner input gets a distinct admission identity");
		driver.submissions.set(String(value.submission), `<submission-${name}>`);
		record(name, value);
	}
	// Re-subscribe to take a fresh, acknowledged snapshot, rather than reading a possibly old replica after an ack.
	const queued = browser.sub("devbox", { kind: "thread", threadId });
	record("queued-view", await browser.until<any>(queued, v => JSON.stringify(v.inbox).includes("Check sample.txt"), 5000));
	record("abort", await bounded(browser.req("devbox", "thread.abort", { threadId }), "abort"));
	const after = browser.sub("devbox", { kind: "thread", threadId });
	await browser.until<any>(after, () => true, 5000);
	let readiness: "settled" | "not-settled" = "settled", reason: string | undefined;
	try { await browser.until<any>(after, value => !value.live?.run, 2000); }
	catch (error) { readiness = "not-settled"; reason = `No-run checkpoint did not settle within 2000 ms: ${String(error)}`; }
	(driver.readiness ??= []).push({ checkpoint: "after-abort", status: readiness, reason, frameEnd: driver.frames.length });
	record("after-abort", browser.values.get(after));
	await driver.captureReaderRange?.();
	// Exercise the same browser wire on both backends. An op error is evidence, never a skipped checkpoint.
	const request = async (name: string, op: string, args: unknown, host = "devbox") => {
		try { const value = await bounded(browser.req(host, op, args), name); record(name, { ok: true, value }); return value; }
		catch (error) { const e = error as Error & { code?: string }; record(name, { ok: false, error: { code: e.code ?? "error", message: e.message } }); return undefined; }
	};
	await request("fleet-search", "sessions.search", { query: "synthetic" });
	const found = await request("find", "thread.find", { threadId, query: "synthetic" });
	const hit = found?.hits?.find((h: any) => h.snippet.includes("sample.txt"));
	assert.ok(hit?.entry && hit?.ref, "Find returns the authored answer and a resolvable reference");
	const opened = await request("find-open", "thread.history", { threadId: hit.threadId, around: hit.entry, version: hit.version, limit: 20 });
	if (opened) assert.ok(opened.entries.some((e: any) => e.id === hit.entry && e.blocks?.some((b: any) => b.text === seedAnswer)), "Find opens its actual hit");
	const cite = parseRef(hit.ref);
	assert.ok(cite?.entry, "the returned citation has host, source and entry coordinates");
	const citation = await request("citation", "thread.entry", { threadId: cite.thread, entry: cite.entry }, cite.host);
	const link = href.ref(hit.ref);
	assert.ok(link, "the committed web helper accepts the actual search reference");
	const route = parseRoute(link);
	assert.equal(route.host, `devbox#${driver.backend === "pi" ? "pi" : "durable"}`);
	assert.equal(route.thread, threadId, "the committed web route names the actual source thread");
	assert.equal(route.entry, hit.entry, "the route keeps the actual hit's entry");
	driver.citationRoute = { ref: hit.ref, href: link, host: route.host!, threadId: route.thread!, entry: route.entry! };
	const webCitation = await request("citation-web", "thread.entry", { threadId: route.thread, entry: route.entry }, route.host);
	for (const value of [citation, webCitation]) if (value) {
		assert.match(value.text, /sample\.txt/);
		assert.equal(value.more, false);
		assert.ok(value.next > 0 && value.version, "citation carries body bounds and version");
	}
	const rarebit = browser.sub("devbox", { kind: "view", view: "rarebit", threadId });
	record("rarebit", await browser.until<any>(rarebit, v => Array.isArray(v.items) || !!v.error, 5000));
	const arc = browser.sub("devbox", { kind: "view", view: "cos.arc", threadId });
	record("arc-evidence", await browser.until<any>(arc, v => Array.isArray(v.chunks) || !!v.error || !!v.missing, 5000));
	const askStart = driver.readArcCalls().length;
	await request("arc-build", "view.cos.arc.build", { threadId });
	const built = await browser.until<any>(arc, v => ["done", "error"].includes(v.job?.state) || !!v.error || !!v.missing, 5000);
	record("arc-built", built);
	driver.arcCalls = driver.readArcCalls().slice(askStart);
	assert.equal(built.job?.state, "done", "the offline helper completes through the hub ask path");
	assert.equal(driver.arcCalls.length, 2, "the hub command records both label and synthesis requests");
	await driver.prepareTeam();
	const team = browser.sub("devbox", { kind: "view", view: "team", threadId });
	record("team", await browser.until<any>(team, v => v.teams?.some((t: any) => t.members?.length >= 2), 5000));
	assert.deepEqual(browser.gaps, [], "hub patch sequence has no gaps");
	assert.ok(driver.frames.some(v => v.t === "snap") && driver.frames.some(v => v.t === "res"));
}

/** Only generated identities and clocks have aliases. Unknown fields, values, order and presence stay observable. */
function canonicalCheckpoints(driver: L1Driver) {
	const aliasTable: { path: string; from: unknown; to: string; reason: string }[] = [];
	const visit = (value: any, path: string, key: string, checkpoint: string): any => {
		let alias: string | undefined, reason = "";
		if (typeof value === "string" && driver.identities.has(value)) {
			alias = driver.identities.get(value); reason = "exact fixture identity";
		} else if (typeof value === "number" && ["ts", "createdAt", "updatedAt", "at", "asOf"].includes(key)) {
			alias = "<clock>"; reason = "generated timestamp; numbers outside these clock fields are preserved";
		} else if (typeof value === "string" && key === "conversationId") {
			alias = "<thread-a>"; reason = "single fixture conversation identity";
		} else if (typeof value === "string" && key === "sourceVersion") {
			alias = "<source-version>"; reason = "generated content-version identity; field presence is preserved";
		} else if ((typeof value === "string" || typeof value === "number") && ["id", "submission"].includes(key) && driver.submissions.has(String(value))) {
			const identity = driver.submissions.get(String(value))!;
			aliasTable.push({ path, from: value, to: identity, reason: "admission identity bound to its authored request; wire type is preserved" });
			return { identity, wireType: typeof value };
		} else if (checkpoint === "overview" && typeof value === "string" && (/\/layout\/workspaces\/0\/id$/.test(path) || /\/location\/workspace$/.test(path))) {
			alias = "<workspace-a>"; reason = "fixture workspace identity";
		} else if (checkpoint === "overview" && typeof value === "string" && (/\/layout\/workspaces\/0\/tabs\/0\/id$/.test(path) || /\/location\/tab$/.test(path))) {
			alias = "<tab-a>"; reason = "fixture tab identity";
		} else if (checkpoint === "overview" && typeof value === "string" && /\/layout\/workspaces\/0\/tabs\/0\/panes\/0$/.test(path)) {
			alias = "<thread-a>"; reason = "fixture placement slot identity";
		}
		if (alias !== undefined) { aliasTable.push({ path, from: value, to: alias, reason }); return alias; }
		if (Array.isArray(value)) return value.map((v, i) => visit(v, `${path}/${i}`, String(i), checkpoint));
		if (value && typeof value === "object") {
			const entry = value.kind === "user" && [seedPrompt, busyPrompt].includes(value.text) ? `<entry-${value.text === seedPrompt ? "seed-user" : "busy-user"}>`
				: value.kind === "assistant" && value.blocks?.some((b: any) => b.text === seedAnswer) ? "<entry-seed-answer>" : undefined;
			return Object.fromEntries(Object.keys(value).sort().map(k => {
				const outKey = driver.identities.get(k) ?? k;
				if (outKey !== k) aliasTable.push({ path: `${path}/${k}`, from: k, to: outKey, reason: "exact fixture key" });
				if (k === "id" && entry) { aliasTable.push({ path: `${path}/id`, from: value[k], to: entry, reason: "fixture entry identified by exact authored content" }); return [outKey, entry]; }
				return [outKey, visit(value[k], `${path}/${outKey}`, k, checkpoint)];
			}));
		}
		return value;
	};
	const values = driver.checkpoints.map(c => ({ name: c.name, value: visit(c.value, `/${c.name}`, "", c.name) }));
	return { values, aliasTable };
}

function differences(pi: any, durable: any, path = ""): { path: string; pi: unknown; durable: unknown }[] {
	if (Object.is(pi, durable)) return [];
	if (pi && durable && typeof pi === "object" && typeof durable === "object" && Array.isArray(pi) === Array.isArray(durable)) {
		return [...new Set([...Object.keys(pi), ...Object.keys(durable)])].flatMap(key => differences(pi[key], durable[key], `${path}/${key}`));
	}
	return [{ path, pi: pi === undefined ? { absent: true } : pi, durable: durable === undefined ? { absent: true } : durable }];
}

/** Only fields read by web/src/views/team/TeamPanel.tsx. Team compares field sets/types, not values. */
function teamPanelShape(value: any): unknown {
	const pick = (row: any, keys: string[]) => Object.fromEntries(keys.filter(k => Object.hasOwn(row, k)).map(k => [k, row[k]]));
	const panel = { ...pick(value, ["availability"]), teams: value.teams.map((team: any) => ({
		...pick(team, ["name", "issues"]),
		members: team.members.map((m: any) => pick(m, ["member", "role", "threadId", "live", "status"])),
		tasks: team.tasks.map((t: any) => pick(t, ["id", "title", "status", "owner", "deps", "ready", "updatedAt"])),
	})) };
	const shape = (v: any): any => Array.isArray(v) ? [...new Map(v.map(x => { const s = shape(x); return [JSON.stringify(s), s]; })).values()]
		: v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, shape(v[k])])) : v === null ? "null" : typeof v;
	return shape(panel);
}

type L1EntryRanges = { pi: { id: unknown; ts: unknown }[]; durable: { id: unknown; ts: unknown }[] };
type L1Difference = ReturnType<typeof differences>[number] & {
	checkpoint: string;
	spendCoverage?: { pi: { usd?: unknown; covers?: unknown }; durable: { usd?: unknown; covers?: unknown } };
	referenceEntries?: { pi: unknown; durable: unknown };
	auditRange?: { rows: { id: number; kind: string }[]; upper: number | null };
	entryRanges?: L1EntryRanges;
	inputDeltas?: L1Difference[];
};

/** Keep full spend context so a coverage leaf cannot hide a changed or missing amount. */
function checkpointDifferences(pi: any, durable: any, checkpoint: string, range?: L1Driver["readerRange"], entryRanges?: L1EntryRanges): L1Difference[] {
	if (citationCheckpoint(checkpoint) && typeof pi?.value?.text === "string" && typeof durable?.value?.text === "string") {
		try {
			const left = JSON.parse(pi.value.text), right = JSON.parse(durable.value.text);
			if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
				pi = { ...pi, value: { ...pi.value, text: left } };
				durable = { ...durable, value: { ...durable.value, text: right } };
			}
		} catch { /* Invalid JSON stays a whole-text delta. Raw checkpoints are never changed. */ }
	}
	const deltas: L1Difference[] = differences(pi, durable).map(delta => {
		const thread = /^\/threads\/([^/]+)\/spend\/covers(?:\/|$)/.exec(delta.path)?.[1];
		const hit = /^\/value\/hits\/(\d+)\/ref$/.exec(delta.path)?.[1];
		let rows: L1Difference["auditRange"];
		if (range) {
			if ((checkpoint === "find" && delta.path === "/value/scanned") || (checkpoint === "rarebit" && delta.path === "/diagnosis/entries")) rows = { rows: range.records, upper: range.upper };
			const chunk = /^\/chunks\/(\d+)\/entries$/.exec(delta.path)?.[1];
			if (arcCheckpoint(checkpoint) && chunk !== undefined) {
				const index = Number(chunk), end = Number(durable.chunks[index].lastEntryId);
				const before = index ? Number(durable.chunks[index - 1].lastEntryId) : 0;
				// The first chunk includes leading system audit rows. firstEntryId can name the first timed message.
				if (range.records.some(r => r.id === end) && (!index || range.records.some(r => r.id === before))) rows = { rows: range.records.filter(r => r.id > before && r.id <= end), upper: end };
			}
		}
		return { checkpoint, ...delta, ...(thread ? { spendCoverage: { pi: pi.threads[thread].spend, durable: durable.threads[thread].spend } } : {}),
			...(hit !== undefined ? { referenceEntries: { pi: pi.value.hits[hit].entry, durable: durable.value.hits[hit].entry } } : {}), ...(rows ? { auditRange: rows } : {}),
			...(checkpoint === "arc-built" && (terminalEntryPath(delta.path) || delta.path === "/contextStatus/coveredAt") && entryRanges ? { entryRanges } : {}) };
	});
	const inputs = deltas.filter(d => !derivedHashPath(d));
	return deltas.map(d => derivedHashPath(d) ? { ...d, inputDeltas: inputs } : d);
}
const arcCheckpoint = (name: string) => ["arc-evidence", "arc-built"].includes(name);
const hitCheckpoint = (name: string) => ["fleet-search", "find"].includes(name);
const citationCheckpoint = (name: string) => ["citation", "citation-web"].includes(name);
const nativeId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const decimalId = (value: unknown) => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const nonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isoClock = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && nonnegative(Date.parse(value)) && new Date(value).toISOString() === value;
const terminalEntryPath = (path: string) => ["/builds/0/afterEntryId", "/cards/0/resumeEntryId", "/context/asOfEntryId"].includes(path);
const terminalIsoClockPath = (path: string) => ["/builds/0/startedAt", "/builds/0/endedAt", "/context/builtAt", "/keptAt", "/synthesis/builtAt"].includes(path);
const terminalDurationPath = (path: string) => /^\/builds\/0\/ms\/[^/]+$/.test(path);
const terminalClockPath = (path: string) => terminalIsoClockPath(path) || terminalDurationPath(path) || path === "/contextStatus/coveredAt";
function completeEntryRanges(histories: any[]): L1EntryRanges | undefined {
	return histories.length === 2 && histories.every(v => v?.ok && v.value?.more === false && Array.isArray(v.value.entries))
		? { pi: histories[0].value.entries.map(({ id, ts }: any) => ({ id, ts })), durable: histories[1].value.entries.map(({ id, ts }: any) => ({ id, ts })) } : undefined;
}
function sourceClockContains(entries: L1EntryRanges["pi"], value: unknown): boolean {
	const clocks = entries.map(e => e.ts);
	return nonnegative(value) && clocks.length > 0 && clocks.every(nonnegative) && (value as number) >= Math.min(...clocks as number[]) && (value as number) <= Math.max(...clocks as number[]);
}
const derivedHashPath = (d: L1Difference) => (d.checkpoint === "rarebit" && d.path === "/fingerprint") || (arcCheckpoint(d.checkpoint) && /^\/chunks\/\d+\/hash$/.test(d.path))
	|| (d.checkpoint === "arc-built" && ["/chunks/0/label/hash", "/context/rarebitFingerprint"].includes(d.path));
const absent = (value: unknown) => !!value && typeof value === "object" && Object.keys(value).length === 1 && (value as { absent?: boolean }).absent === true;
const sessionCheckpoint = (name: string) => ["session", "queued-view", "after-abort"].includes(name);
// Lead-accepted comparison policy only. Raw and identity-normalized values remain intact for audit.
/** The suffix the one spend rule adds to a history-derived Pi figure. */
const historySuffix = spendSuffix(historySpend(0));
const acceptedNormalizationRules: { name: string; status: "accepted"; provisional?: true; reason: string; matches(delta: L1Difference): boolean }[] = [
	{ name: "transport-via", status: "accepted", reason: "The web reads no via field; node and control name different transports.",
		matches: d => ["steer", "queue", "abort"].includes(d.checkpoint) && d.path === "/via" && d.pi === "control" && d.durable === "node" },
	{ name: "durable-backend", status: "accepted", reason: "The web reads no backend field; durable is the accepted backend marker.",
		matches: d => d.checkpoint === "overview" && d.path === "/backend" && d.pi === "pi" && d.durable === "durable" },
	{ name: "durable-live-details", status: "accepted", reason: "Durable live.run extends activity with taskId/inputs and adds generation/tools/compactions. L3 rendering remains pending; activity still compares.",
		matches: d => sessionCheckpoint(d.checkpoint) && absent(d.pi) && (
			(d.path === "/live/run/taskId" && typeof d.durable === "number") ||
			(d.path === "/live/run/inputs" && Array.isArray(d.durable) && d.durable.every(v => typeof v === "number")) ||
			(d.path === "/live/generation" && !!d.durable && typeof d.durable === "object" && !Array.isArray(d.durable)) ||
			(["/live/tools", "/live/compactions"].includes(d.path) && Array.isArray(d.durable))) },
	{ name: "durable-context-window", status: "accepted", reason: "contextWindow can appear only on durable; this is an accepted additive model limit.",
		matches: d => d.checkpoint === "overview" && d.path === "/threads/<thread-a>/contextWindow" && absent(d.pi) && typeof d.durable === "number" && d.durable > 0 },
	{ name: "source-reference", status: "accepted", reason: "Same-host Pi versus durable source identities may differ in Overview, search-hit citations and Arc references. Hit fragments must match the actual native entry IDs.",
		matches: d => {
			const hit = hitCheckpoint(d.checkpoint) && /^\/value\/hits\/\d+\/ref$/.test(d.path);
			const plain = (d.checkpoint === "overview" && /^\/threads\/[^/]+\/ref$/.test(d.path)) || (arcCheckpoint(d.checkpoint) && d.path === "/ref");
			if ((!hit && !plain) || typeof d.pi !== "string" || typeof d.durable !== "string") return false;
			const pi = /^([^/\s#]+)\/pi:([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_-]+))?$/.exec(d.pi);
			const durable = /^([^/\s#]+)\/pi-durable:([rt][0-9a-z]+)\.([1-9][0-9]*)(?:#([1-9][0-9]*))?$/.exec(d.durable);
			return !!pi && !!durable && pi[1] === durable[1] && (hit
				? !!d.referenceEntries && nativeId(d.referenceEntries.pi) && decimalId(d.referenceEntries.durable) && pi[3] === d.referenceEntries.pi && durable[4] === d.referenceEntries.durable
				: pi[3] === undefined && durable[4] === undefined);
		} },
	{ name: "native-entry-id", status: "accepted", reason: "Pi native IDs versus durable positive decimal entry IDs retain each source's identity format. Terminal Build result IDs must occur in each source's captured complete entry range.",
		matches: d => nativeId(d.pi) && decimalId(d.durable) && ((d.checkpoint === "arc-built" && terminalEntryPath(d.path)
			&& !!d.entryRanges && d.entryRanges.pi.some(e => e.id === d.pi) && d.entryRanges.durable.some(e => e.id === d.durable))
			|| (hitCheckpoint(d.checkpoint) && /^\/value\/hits\/\d+\/entry$/.test(d.path))
			|| (citationCheckpoint(d.checkpoint) && d.path === "/value/text/id") || (d.checkpoint === "rarebit" && /^\/items\/\d+\/id$/.test(d.path)) || (arcCheckpoint(d.checkpoint) && /^\/chunks\/\d+\/(firstEntryId|lastEntryId|lastOwnerEntryId)$/.test(d.path))) },
	{ name: "source-version", status: "accepted", reason: "The shared reader/chunker/excerpt prefix must agree; Pi and durable encode different native source tails.",
		matches: d => {
			const path = (hitCheckpoint(d.checkpoint) && /^\/value\/hits\/\d+\/version$/.test(d.path)) || ((d.checkpoint === "find-open" || citationCheckpoint(d.checkpoint)) && d.path === "/value/version")
				|| ((d.checkpoint === "rarebit" || arcCheckpoint(d.checkpoint)) && d.path === "/source/version");
			const prefix = "8/ampi-arc-chunker/4/ampi-arc-excerpt/2:";
			return path && typeof d.pi === "string" && typeof d.durable === "string" && d.pi.startsWith(prefix) && d.durable.startsWith(prefix)
				&& /^2:[a-f0-9]{64}:\d+$/.test(d.pi.slice(prefix.length)) && /^1:pi-durable:[^:\s/#]+:[rt][a-z0-9]+\.[1-9][0-9]*:[a-f0-9]{12}:[1-9][0-9]*\.[a-f0-9]{16}$/.test(d.durable.slice(prefix.length));
		} },
	{ name: "fixture-clock", status: "accepted", provisional: true, reason: "Provisional fixture clock exception: exact Rarebit/citation/Arc time paths may differ with valid ISO clocks or nonnegative finite numbers. Terminal coveredAt must lie within each source's complete captured message-time window. This does not prove production time semantics.",
		matches: d => {
			if (d.checkpoint === "arc-built" && d.path === "/contextStatus/coveredAt") return !!d.entryRanges && sourceClockContains(d.entryRanges.pi, d.pi) && sourceClockContains(d.entryRanges.durable, d.durable);
			const iso = (d.checkpoint === "rarebit" && /^\/items\/\d+\/t$/.test(d.path)) || (arcCheckpoint(d.checkpoint) && /^\/chunks\/\d+\/(startAt|endAt)$/.test(d.path))
				|| (d.checkpoint === "arc-built" && terminalIsoClockPath(d.path));
			return iso ? isoClock(d.pi) && isoClock(d.durable) : ((d.checkpoint === "rarebit" && d.path === "/diagnosis/ms")
				|| (citationCheckpoint(d.checkpoint) && d.path === "/value/text/ts") || (d.checkpoint === "arc-built" && terminalDurationPath(d.path))) && nonnegative(d.pi) && nonnegative(d.durable);
		} },
	{ name: "durable-system-audit-entry", status: "accepted", reason: "Durable counts may exceed Pi only by the exact pi.system row count in the captured complete reader range. Arc ranges include leading audit rows.",
		matches: d => {
			const path = (d.checkpoint === "find" && d.path === "/value/scanned") || (d.checkpoint === "rarebit" && d.path === "/diagnosis/entries") || (arcCheckpoint(d.checkpoint) && /^\/chunks\/\d+\/entries$/.test(d.path));
			const range = d.auditRange;
			return path && Number.isSafeInteger(d.pi) && Number.isSafeInteger(d.durable) && (d.pi as number) >= 0 && !!range && range.rows.length === d.durable
				&& range.rows.at(-1)?.id === range.upper && range.rows.every(r => Number.isSafeInteger(r.id) && r.id > 0 && r.id <= (range.upper ?? -1) && typeof r.kind === "string") && new Set(range.rows.map(r => r.id)).size === range.rows.length
				&& d.durable === (d.pi as number) + range.rows.filter(r => r.kind === "pi.system").length;
		} },
	{ name: "observed-revision", status: "accepted", reason: "Rarebit revisions are local observation counters, not content identity.",
		matches: d => d.checkpoint === "rarebit" && d.path === "/revision" && Number.isSafeInteger(d.pi) && Number.isSafeInteger(d.durable) && (d.pi as number) >= 0 && (d.durable as number) >= 0 },
	{ name: "derived-hash", status: "accepted", reason: "Exact fingerprint, chunk and terminal label/context hash paths may differ only when every non-hash input delta in that checkpoint has an accepted rule.",
		matches: d => derivedHashPath(d) && typeof d.pi === "string" && typeof d.durable === "string" && /^[a-f0-9]{64}$/.test(d.pi) && /^[a-f0-9]{64}$/.test(d.durable)
			&& !!d.inputDeltas && d.inputDeltas.every(input => input.checkpoint === d.checkpoint && !derivedHashPath(input) && !!acceptedRule(input)) },
	{ name: "pane-location-removal", status: "accepted", reason: "Scope R1 removes the Herdr pane coordinate. Tab and workspace placement still compare.",
		matches: d => d.checkpoint === "overview" && d.path === "/threads/<thread-a>/location/pane" && typeof d.pi === "string" && absent(d.durable) },
	{ name: "spend-coverage-suffix", status: "accepted", reason: "Pi history covers responses and failed runs; durable covers every cost class. Only the shared priced-label suffix or structured covers may differ. Structured usd must agree, including null; no-price labels carry no suffix.",
		matches: d => {
			if (d.checkpoint !== "overview") return false;
			if (/^\/threads\/[^/]+\/spendLabel$/.test(d.path)) return typeof d.durable === "string"
				&& /^(?:\$0|\$\d+\.\d{2}|<\$0\.01)$/.test(d.durable)
				&& d.pi === `${d.durable}${historySuffix}`;
			const spend = d.spendCoverage;
			return /^\/threads\/[^/]+\/spend\/covers(?:\/|$)/.test(d.path) && !!spend
				&& (spend.pi.usd === null || (typeof spend.pi.usd === "number" && Number.isFinite(spend.pi.usd)))
				&& Object.is(spend.pi.usd, spend.durable.usd)
				&& JSON.stringify(spend.pi.covers) === JSON.stringify(HISTORY_COVERS)
				&& JSON.stringify(spend.durable.covers) === JSON.stringify(ALL_COVERS);
		} },
];
function acceptedRule(delta: L1Difference) { return acceptedNormalizationRules.find(rule => rule.matches(delta)); }

test("durable L1 reader rules retain malformed identities, semantic changes and unproved audit/hash differences", () => {
	const delta = (checkpoint: string, path: string, pi: unknown, durable: unknown): L1Difference => ({ checkpoint, path, pi, durable });
	const native = delta("find", "/value/hits/0/entry", "a1", "19");
	assert.equal(acceptedRule(native)?.name, "native-entry-id");
	for (const value of [undefined, null, "", "0", "-1", "1.2", "19#x", 19]) assert.equal(acceptedRule({ ...native, durable: value }), undefined);
	for (const [checkpoint, path] of [["session", native.path], ["find", "/value/entry"], ["rarebit", "/stats/id"], ["arc-evidence", "/chunks/0/id"]]) assert.equal(acceptedRule({ ...native, checkpoint, path }), undefined);
	const cite = { ...delta("find", "/value/hits/0/ref", "devbox/pi:sess-a#a1", "devbox/pi-durable:rabc123.3#19"), referenceEntries: { pi: "a1", durable: "19" } };
	assert.equal(acceptedRule(cite)?.name, "source-reference");
	for (const value of [undefined, "other/pi-durable:rabc123.3#19", "devbox/pi-durable:rabc123.3#20", "devbox/pi-durable:rabc123.0#19", "devbox/pi-durable:rabc123.3#a1", "devbox/pi-durable:rabc123.3"]) assert.equal(acceptedRule({ ...cite, durable: value }), undefined);
	assert.equal(acceptedRule({ ...cite, referenceEntries: undefined }), undefined, "hit fragments need native entry context");
	assert.equal(acceptedRule({ ...cite, pi: "devbox/pi:sess-a", durable: "devbox/pi-durable:rabc123.3", referenceEntries: { pi: undefined, durable: undefined } }), undefined, "missing entries cannot validate fragment-free hits");
	assert.equal(acceptedRule({ ...cite, checkpoint: "session" }), undefined);
	assert.equal(acceptedRule(delta("arc-evidence", "/ref", "devbox/pi:sess-a", "devbox/pi-durable:rabc123.3"))?.name, "source-reference");
	assert.equal(acceptedRule(delta("arc-evidence", "/ref", cite.pi, cite.durable)), undefined, "Arc source refs have no entry fragment");
	const prefix = "8/ampi-arc-chunker/4/ampi-arc-excerpt/2:";
	const version = delta("find-open", "/value/version", `${prefix}2:${"a".repeat(64)}:999`, `${prefix}1:pi-durable:devbox:rabc123.3:${"a".repeat(12)}:20.${"b".repeat(16)}`);
	assert.equal(acceptedRule(version)?.name, "source-version");
	for (const value of [undefined, "", "different", (version.durable as string).replace("chunker/4", "chunker/5"), `${prefix}2:bare`, (version.durable as string).replace("rabc123.3", "rabc123.0")]) assert.equal(acceptedRule({ ...version, durable: value }), undefined);
	assert.equal(acceptedRule({ ...version, path: "/unrelated/version" }), undefined);
	const clock = delta("rarebit", "/items/0/t", "2026-10-24T00:00:00.000Z", "2026-10-25T00:00:00.000Z");
	assert.equal(acceptedRule(clock)?.name, "fixture-clock");
	assert.equal(acceptedRule(clock)?.provisional, true);
	for (const value of [undefined, null, 0, "yesterday", "2026-02-31T00:00:00.000Z", "2026-10-25", "1960-01-01T00:00:00.000Z"]) assert.equal(acceptedRule({ ...clock, durable: value }), undefined);
	for (const path of ["/ms", "/at", "/diagnosis/at"]) assert.equal(acceptedRule(delta("rarebit", path, 1, 2)), undefined);
	assert.equal(acceptedRule(delta("rarebit", "/diagnosis/ms", 0, 2))?.name, "fixture-clock");
	for (const value of [-1, Infinity, NaN, "2", null]) assert.equal(acceptedRule(delta("rarebit", "/diagnosis/ms", 1, value)), undefined);
	const audit = { ...delta("find", "/value/scanned", 2, 4), auditRange: { upper: 4, rows: [{ id: 1, kind: "pi.system" }, { id: 2, kind: "pi.user" }, { id: 3, kind: "pi.system" }, { id: 4, kind: "pi.assistant" }] } };
	assert.equal(acceptedRule(audit)?.name, "durable-system-audit-entry", "two audit rows require exactly two extra entries");
	for (const bad of [{ ...audit, durable: 3 }, { ...audit, pi: 3 }, { ...audit, auditRange: undefined }, { ...audit, path: "/value/count" },
		{ ...audit, auditRange: { ...audit.auditRange, upper: 3 } }, { ...audit, auditRange: { ...audit.auditRange, rows: audit.auditRange.rows.map(r => r.id === 3 ? { ...r, kind: "pi.custom" } : r) } }]) assert.equal(acceptedRule(bad), undefined);
	const range = { upper: 4, records: audit.auditRange.rows };
	const arcCounts = checkpointDifferences({ chunks: [{ firstEntryId: "u1", lastEntryId: "a1", entries: 2 }] }, { chunks: [{ firstEntryId: "2", lastEntryId: "4", entries: 4 }] }, "arc-evidence", range);
	assert.equal(acceptedRule(arcCounts.find(d => d.path === "/chunks/0/entries")!)?.name, "durable-system-audit-entry", "the chunk range includes a system row before firstEntryId");
	const incomplete = checkpointDifferences({ chunks: [{ entries: 2 }] }, { chunks: [{ firstEntryId: "2", lastEntryId: "9", entries: 4 }] }, "arc-evidence", range);
	assert.equal(acceptedRule(incomplete.find(d => d.path === "/chunks/0/entries")!), undefined, "a missing range endpoint cannot establish an audit count");
	const revision = delta("rarebit", "/revision", 1, 2);
	assert.equal(acceptedRule(revision)?.name, "observed-revision");
	for (const value of [undefined, -1, 1.5, "2", Infinity]) assert.equal(acceptedRule({ ...revision, durable: value }), undefined);
	assert.equal(acceptedRule({ ...revision, checkpoint: "arc-evidence" }), undefined);
	const pi = { fingerprint: "a".repeat(64), items: [{ id: "a1", text: "answer" }], revision: 1 };
	const durable = { fingerprint: "b".repeat(64), items: [{ id: "19", text: "answer" }], revision: 2 };
	const compared = checkpointDifferences(pi, durable, "rarebit");
	assert.ok(compared.every(d => acceptedRule(d)), "derived hash depends on accepted native ID/revision inputs");
	for (const changed of [{ ...durable, unexpected: true }, { ...durable, items: [{ id: "19", text: "changed answer" }] }, { ...durable, revision: "2" }]) {
		const hash = checkpointDifferences(pi, changed, "rarebit").find(d => d.path === "/fingerprint")!;
		assert.equal(acceptedRule(hash), undefined, "semantic or unknown input differences keep the derived hash open");
	}
	const hash = compared.find(d => d.path === "/fingerprint")!;
	assert.equal(acceptedRule({ ...hash, inputDeltas: undefined }), undefined);
	assert.equal(acceptedRule({ ...hash, durable: "not-a-hash" }), undefined);
	assert.equal(acceptedRule({ ...hash, inputDeltas: [native] }), undefined, "a different checkpoint cannot justify this hash");
	assert.equal(acceptedRule({ ...hash, path: "/unrelated/hash" }), undefined);
	const body = { id: "a1", kind: "assistant", ts: Date.parse(at), blocks: [{ type: "text", text: seedAnswer }], stop: "stop" };
	const otherBody = { ...body, id: "19", ts: Date.parse(at) + 1000 };
	const reply = (text: unknown, version: unknown) => ({ ok: true, value: { text, version, more: false, next: 133 } });
	for (const checkpoint of ["citation", "citation-web"]) {
		const left = reply(JSON.stringify(body), version.pi), right = reply(JSON.stringify(otherBody), version.durable);
		const deltas = checkpointDifferences(left, right, checkpoint);
		assert.deepEqual(deltas.map(d => [d.path, acceptedRule(d)?.name]), [["/value/text/id", "native-entry-id"], ["/value/text/ts", "fixture-clock"], ["/value/version", "source-version"]]);
		assert.equal(typeof left.value.text, "string", "parsed comparison keeps the raw citation text");
		for (const change of [{ ...otherBody, blocks: [{ type: "text", text: "different answer" }] }, { ...otherBody, kind: "user" }, { ...otherBody, stop: "error" },
			{ ...otherBody, unknown: true }, { ...otherBody, id: undefined }, { ...otherBody, ts: undefined }, { ...otherBody, id: "0" }, { ...otherBody, ts: -1 }, { ...otherBody, ts: "later" }]) {
			assert.ok(checkpointDifferences(left, reply(JSON.stringify(change), version.durable), checkpoint).some(d => !acceptedRule(d)), "content, kind, stop, unknown fields and missing/invalid identity or clock stay open");
		}
		for (const text of ["{broken", "null", "[]", '"primitive"']) {
			const deltas = checkpointDifferences(left, reply(text, version.durable), checkpoint);
			assert.ok(deltas.some(d => d.path === "/value/text" && !acceptedRule(d)), "invalid JSON or a non-object body stays a whole-text delta");
		}
		assert.ok(checkpointDifferences(left, reply(JSON.stringify(otherBody), "wrong-version"), checkpoint).some(d => d.path === "/value/version" && !acceptedRule(d)));
	}
	assert.equal(acceptedRule(delta("citation", "/value/ts", 1, 2)), undefined, "citation clocks apply only inside its parsed body");
	assert.equal(acceptedRule(delta("session", "/value/text/id", "a1", "19")), undefined);
});

test("durable L1 terminal Arc rules require native ranges, valid clocks and accepted hash inputs", () => {
	const ms = Date.parse(at), iso = (offset: number) => new Date(ms + offset).toISOString();
	const entryRanges: L1EntryRanges = {
		pi: [{ id: "u1", ts: ms }, { id: "a1", ts: ms + 1000 }, { id: "u2", ts: ms + 2000 }],
		durable: [{ id: "14", ts: ms + 10000 }, { id: "19", ts: ms + 11000 }, { id: "20", ts: ms + 12000 }],
	};
	const pi = { builds: [{ afterEntryId: "a1", startedAt: iso(3000), endedAt: iso(4000), ms: { labels: 1, arc: 2 } }],
		cards: [{ resumeEntryId: "u2" }], chunks: [{ hash: "a".repeat(64), label: { hash: "a".repeat(64) } }],
		context: { asOfEntryId: "u2", builtAt: iso(4000), rarebitFingerprint: "c".repeat(64) }, contextStatus: { coveredAt: ms + 2000 }, keptAt: iso(4000), synthesis: { builtAt: iso(4000) } };
	const durable = { builds: [{ afterEntryId: "19", startedAt: iso(13000), endedAt: iso(14000), ms: { labels: 3, arc: 4 } }],
		cards: [{ resumeEntryId: "20" }], chunks: [{ hash: "b".repeat(64), label: { hash: "b".repeat(64) } }],
		context: { asOfEntryId: "20", builtAt: iso(14000), rarebitFingerprint: "d".repeat(64) }, contextStatus: { coveredAt: ms + 12000 }, keptAt: iso(14000), synthesis: { builtAt: iso(14000) } };
	const deltas = checkpointDifferences(pi, durable, "arc-built", undefined, entryRanges);
	assert.equal(deltas.length, 14);
	assert.ok(deltas.every(d => acceptedRule(d)), "all exact terminal paths qualify with complete source evidence");
	for (const d of deltas.filter(d => terminalEntryPath(d.path))) {
		assert.equal(acceptedRule(d)?.name, "native-entry-id");
		for (const value of [undefined, null, 19, "0", "999"]) assert.equal(acceptedRule({ ...d, durable: value }), undefined, "durable ID must be a native string in its range");
		for (const value of [undefined, null, 1, "missing"]) assert.equal(acceptedRule({ ...d, pi: value }), undefined, "Pi ID must belong to its range");
		assert.equal(acceptedRule({ ...d, entryRanges: undefined }), undefined);
		assert.equal(acceptedRule({ ...d, checkpoint: "arc-evidence" }), undefined);
	}
	for (const d of deltas.filter(d => terminalIsoClockPath(d.path))) {
		assert.equal(acceptedRule(d)?.name, "fixture-clock");
		assert.equal(acceptedRule(d)?.provisional, true);
		for (const value of [undefined, null, -1, NaN, "yesterday", "2026-02-31T00:00:00.000Z"]) {
			assert.equal(acceptedRule({ ...d, durable: value }), undefined);
			assert.equal(acceptedRule({ ...d, pi: value }), undefined);
		}
	}
	for (const d of deltas.filter(d => terminalDurationPath(d.path))) {
		for (const value of [-1, NaN, Infinity, "1", null]) {
			assert.equal(acceptedRule({ ...d, durable: value }), undefined);
			assert.equal(acceptedRule({ ...d, pi: value }), undefined);
		}
	}
	const covered = deltas.find(d => d.path === "/contextStatus/coveredAt")!;
	for (const value of [-1, NaN, Infinity, "yesterday", iso(12000), ms + 9999, ms + 12001, ms + 14000]) assert.equal(acceptedRule({ ...covered, durable: value }), undefined, "coveredAt rejects invalid values, out-of-window values and later Build time");
	for (const value of [-1, NaN, Infinity, "yesterday", ms - 1, ms + 2001, ms + 4000]) assert.equal(acceptedRule({ ...covered, pi: value }), undefined);
	assert.equal(acceptedRule({ ...covered, entryRanges: undefined }), undefined);
	assert.equal(acceptedRule({ ...covered, entryRanges: { ...entryRanges, durable: [] } }), undefined);
	assert.equal(acceptedRule({ ...covered, entryRanges: { ...entryRanges, durable: [{ id: "19", ts: NaN }] } }), undefined);
	const histories = [entryRanges.pi, entryRanges.durable].map(entries => ({ ok: true, value: { entries, more: false } }));
	assert.deepEqual(completeEntryRanges(histories), entryRanges);
	for (const history of [undefined, { ok: false }, { ok: true, value: { entries: entryRanges.pi, more: true } }, { ok: true, value: { entries: entryRanges.pi } }]) {
		const incomplete = completeEntryRanges([history, histories[1]]);
		assert.equal(incomplete, undefined, "only two complete successful histories supply source evidence");
		assert.ok(checkpointDifferences(pi, durable, "arc-built", undefined, incomplete).filter(derivedHashPath).every(d => !acceptedRule(d)));
	}
	for (const hash of deltas.filter(derivedHashPath)) {
		assert.equal(acceptedRule(hash)?.name, "derived-hash");
		assert.equal(acceptedRule({ ...hash, durable: "wrong-hash" }), undefined);
		assert.equal(acceptedRule({ ...hash, inputDeltas: undefined }), undefined);
		assert.equal(acceptedRule({ ...hash, checkpoint: "session" }), undefined);
		assert.equal(acceptedRule({ ...hash, inputDeltas: [...hash.inputDeltas!, { checkpoint: "arc-built", path: "/unknown", pi: "original", durable: "changed" }] }), undefined);
		assert.equal(acceptedRule({ ...hash, inputDeltas: [hash] }), undefined, "hashes cannot justify one another");
	}
	const changed = { ...durable, context: { ...durable.context, unexpected: true } };
	assert.ok(checkpointDifferences(pi, changed, "arc-built", undefined, entryRanges).filter(derivedHashPath).every(d => !acceptedRule(d)), "one unaccepted semantic input keeps all three hashes open");
	for (const [example, paths] of [
		[deltas.find(d => terminalEntryPath(d.path))!, ["/builds/1/afterEntryId", "/cards/1/resumeEntryId", "/context/otherId"]],
		[deltas.find(d => terminalIsoClockPath(d.path))!, ["/builds/1/startedAt", "/context/otherAt"]],
		[deltas.find(d => terminalDurationPath(d.path))!, ["/builds/1/ms/arc", "/builds/0/ms/arc/detail"]],
		[covered, ["/contextStatus/otherAt"]],
		[deltas.find(derivedHashPath)!, ["/chunks/1/label/hash", "/context/otherHash"]],
	] as [L1Difference, string[]][]) {
		for (const path of paths) assert.equal(acceptedRule({ ...example, path }), undefined, "unrelated paths do not inherit terminal rules");
	}
});

// The paired test emits findings instead of treating capture success as parity.
test("durable L1 paired capture: shared owner scenario reports control and reader differences", { timeout: 25_000 }, async () => {
	const started = performance.now();
	const proof = mkdtempSync(join(resolve(process.env.AMPI_DURABLE_PROOF ?? tmpdir()), "ampi-durable-l1-paired-"));
	const drivers: L1Driver[] = [];
	const modelRequests: unknown[] = [], modelResults: any[] = [];
	let error: string | undefined;
	let findings: any[] = [], accepted: any[] = [];
	const sourceFiles = ["../src/node/runtime.ts", "../src/node/server.ts", "../src/node/projection.ts", "../src/hub/hub.ts", "../src/hub/hosts.ts", "../src/hub/durable-host.ts", "../src/pi/host.ts", "../src/durable/reader-side.ts", "../web/src/util.ts", "../web/src/views/team/TeamPanel.tsx", "./pi-fixtures.ts", "./durable-l1.test.ts"];
	const sourceHashes = () => Object.fromEntries(sourceFiles.map(path => [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")]));
	const beforeSources = sourceHashes();
	let cleanupDurable: (() => Promise<void>) | undefined;
	let cleanupPi: (() => Promise<void>) | undefined;
	try {
		const home = mkdtempSync(join(tmpdir(), "ampi-l1-node-"));
		const askCalls = join(home, "ask-calls.jsonl");
		writeFileSync(askCalls, "");
		const readArcCalls = () => readFileSync(askCalls, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
		const offlineArc = `const fs=require('node:fs');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);fs.appendFileSync(${JSON.stringify(askCalls)},JSON.stringify(p)+'\\n');const id=(JSON.stringify(p).match(/\\[([^\\]]+)\\] (?:USER|AGENT):/)||[])[1];console.log(JSON.stringify(p.chunks?{chunks:p.chunks.map(c=>({chunk:c.chunk,topic:'Synthetic files',project:'Fixture',ideas:[]}))}:{headline:'Synthetic file work',projects:[],transitions:[],asks:[],threads:[{label:'Synthetic files',state:'active',progress:[{text:'Synthetic evidence recorded',citations:[id]}],decisions:[],blockers:[]}],unassigned:{progress:[],decisions:[],blockers:[]}}));});`;
		const askCommand = [process.execPath, "-e", offlineArc];
		const helperModels = { arcLabels: "fixture/synthetic", arcSynthesis: "fixture/synthetic" };
		assert.equal(process.env.AMPI_SOCKET, undefined, "test refuses a socket override");
		const models = createModels();
		const sim = fauxProvider({ provider: "fixture", api: "l1-sim", models: [{ id: "synthetic" }], tokensPerSecond: 1e9 });
		let busyEntered!: () => void;
		const busy = new Promise<void>(resolve => { busyEntered = resolve; });
		sim.setResponses([fauxAssistantMessage(seedAnswer), async (_context, options) => {
			busyEntered();
			await new Promise<void>(resolve => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("stopped", { stopReason: "aborted" });
		}]);
		// Capture provider-native messages, before the node projection. The Pi seed uses the same model message.
		models.setProvider({ ...sim.provider, streamSimple(model, context, options) {
			modelRequests.push(structuredClone(context));
			const stream = sim.provider.streamSimple(model, context, options);
			void stream.result().then(message => modelResults.push(structuredClone(message)));
			return stream;
		} });
		const daemon = await runDaemon({ home, models, plugins: [teamPlugin()], testProviders: ["fixture"] });
		const durableFrames: any[] = [];
		const durableHub = new Hub({ models: helperModels, hosts: [{ id: "devbox", label: "devbox", kind: "local", home, askCommand }] }, { token: "d".repeat(64) });
		let durableBrowser: Browser | undefined;
		cleanupDurable = async () => { durableBrowser?.ws.terminate(); await durableHub.close(); await daemon.stop(); rmSync(home, { recursive: true, force: true }); };
		durableBrowser = await attachBrowser(durableHub, durableFrames);
		const { threadId } = await bounded(durableBrowser.req("devbox", "thread.create", { cwd: home, model: { provider: "fixture", modelId: "synthetic" }, prompt: seedPrompt, requestId: "l1-seed", place: { workspace: "new", label: "main" } }), "durable seed");
		const seeded = durableBrowser.sub("devbox", { kind: "thread", threadId });
		await durableBrowser.until<any>(seeded, v => v.entries.some((e: any) => e.kind === "assistant" && e.stop === "stop"), 5000);
		await bounded(durableBrowser.req("devbox", "thread.submit", { threadId, content: busyPrompt, requestId: "l1-busy" }), "busy turn");
		await bounded(busy, "model enters busy barrier");
		const durable: L1Driver = { backend: "durable", browser: durableBrowser, hub: durableHub, threadId, frames: durableFrames, checkpoints: [],
			identities: new Map([[home, "<cwd>"], [threadId, "<thread-a>"]]), submissions: new Map(), stop: cleanupDurable, readArcCalls,
			captureReaderRange: async () => {
				const reader = createReaderService({ context: BACKGROUND_CONTEXT, epoch: 1, resolve: async (id: string) => (await daemon.runtime.thread(id)).conversation }).connect();
				const { handle } = await reader.open({ threadId });
				try {
					const { upper } = await reader.fence({ handle });
					const page = await reader.entries({ handle, order: "ascending", maxEntryId: upper, limit: 400 });
					assert.equal(page.more, false, "audit evidence must cover the entire bounded fixture range");
					assert.ok(page.items.every((item: any) => item.type === "entry"), "audit evidence cannot skip oversized rows");
					const records = page.items.map((item: any) => item.record);
					durable.readerRange = { upper, records: records.map((r: any) => ({ id: r.id, kind: r.kind })) };
					writeFileSync(join(proof, "durable-reader-range.json"), JSON.stringify({ upper, complete: true, records }, null, 2));
				} finally { await reader.close({ handle }); }
			},
			prepareTeam: async () => {
				sim.setResponses([
					fauxAssistantMessage(fauxToolCall("team_create", { name: "l1-team", purpose: "Synthetic panel shape" }), { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxToolCall("ensure_worker", { name: "builder", scope: "Inspect the synthetic file" }), { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxToolCall("task_graph_apply", { operation_id: "l1-graph", tasks: [{ key: "inspect", title: "Inspect file", goal: "Report sample.txt", assignee: "builder" }] }), { stopReason: "toolUse" }),
					...Array.from({ length: 8 }, () => fauxAssistantMessage("Synthetic Team input received.")),
				]);
				const native = durableBrowser!.sub("devbox", { kind: "team", teamId: threadId });
				await bounded(durableBrowser!.req("devbox", "thread.submit", { threadId, content: "Create the synthetic Team", requestId: "l1-team" }), "Team input");
				const authority = await durableBrowser!.until<any>(native, v => v.workers?.length === 1 && v.tasks?.length === 1 && v.deliveries?.some((d: any) => d.kind === "task" && d.submittedAt), 5000);
				writeFileSync(join(proof, "durable-team-authority.json"), JSON.stringify(authority, null, 2));
			},
			effects: () => ({ modelRequests, modelResults, gaps: durableBrowser!.gaps, configuredProviders: models.getProviders().map(p => p.id),
				askCalls: durable.arcCalls, allAskCalls: readArcCalls(), helperModels, askCommand, citationRoute: durable.citationRoute }) };
		drivers.push(durable);

		const f = fixture();
		const state = f.state;
		const workerAgent = state.agents.find((a: any) => a.pane_id === "w1:p1");
		const workerSession = readFileSync(f.sessionB);
		const observationFile = join(f.dir, "observation.json"), observationModule = join(f.dir, "observation.mjs");
		writeFileSync(observationFile, JSON.stringify({ schema: "pi-teams-observation/1", availability: "available", issues: [], teams: [], tasks: {} }));
		// Same public observation fixture boundary as pi-view-team.test.ts; no real Team receives input.
		writeFileSync(observationModule, `import fs from 'node:fs'; const read=()=>JSON.parse(fs.readFileSync(${JSON.stringify(observationFile)},'utf8')); export const readObservationSnapshot=async()=>read(); export const readTaskSnapshot=({teamName})=>read().tasks[teamName];`);
		state.agents = state.agents.filter((a: any) => a.pane_id === "w1:p2");
		Object.assign(state.agents[0], { cwd: home, terminal_title_stripped: seedPrompt });
		state.workspaces = state.workspaces.filter((w: any) => w.workspace_id === "w1");
		state.workspaces[0].label = "main";
		state.tabs = state.tabs.filter((t: any) => t.tab_id === "w1:tA");
		f.setState(state);
		rmSync(f.sessionB);
		const initial = modelResults[0];
		assert.equal(initial?.content?.[0]?.text, seedAnswer, "Pi seed comes from the raw simulated provider result, not a durable UI projection");
		writeFileSync(f.sessionA,
			line({ type: "session", version: 3, id: "sess-a", timestamp: at, cwd: home }) +
			line({ type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: seedPrompt }], timestamp: Date.parse(at) } }) +
			line({ type: "message", id: "a1", parentId: "u1", timestamp: at, message: initial }) +
			line({ type: "message", id: "u2", parentId: "a1", timestamp: at, message: { role: "user", content: [{ type: "text", text: busyPrompt }], timestamp: Date.parse(at) } }));
		const ctl = await control(f, f.sessionA, { queue: true, trackPending: true, settleOnAbort: true });
		const bin = join(f.dir, "bin"); mkdirSync(bin);
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\necho 'L1 refuses fallback Herdr' >&2\nexit 1\n", { mode: 0o755 });
		const piFrames: any[] = [];
		const piHub = new Hub({ backend: "pi", models: helperModels, hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: join(f.dir, "cache"),
			askCommand,
			agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teamsMs: 50, ptbObservation: observationModule, controlStatusMs: 100 },
			env: { HOME: f.dir, PATH: `${bin}:${process.env.PATH ?? ""}`, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") },
		}] }, { token: "d".repeat(64) });
		let piBrowser: Browser | undefined;
		cleanupPi = async () => { piBrowser?.ws.terminate(); await piHub.close(); await new Promise<void>(done => ctl.close().once("close", done)); rmSync(f.dir, { recursive: true, force: true }); };
		piBrowser = await attachBrowser(piHub, piFrames);
		const pi: L1Driver = { backend: "pi", browser: piBrowser, hub: piHub, threadId: "pi:sess-a", frames: piFrames, checkpoints: [],
			identities: new Map([[home, "<cwd>"], [f.sessionA, "<session-a-path>"], ["pi:sess-a", "<thread-a>"]]), submissions: new Map(), stop: cleanupPi, readArcCalls,
			prepareTeam: async () => {
				writeFileSync(f.sessionB, workerSession);
				const next = f.state; next.agents.push(workerAgent); f.setState(next);
				const member = (name: string, session: string, pane: string, role: string) => ({ teamName: "l1-team", memberName: name, coordinationRole: role, membershipId: `l1-team/${name}`, lifecycle: { state: "current" }, session: { kind: "pi-jsonl-path", locator: session }, terminalTarget: { backend: "herdr", kind: "pane", targetId: pane } });
				writeFileSync(observationFile, JSON.stringify({ schema: "pi-teams-observation/1", availability: "available", issues: [],
					teams: [{ teamName: "l1-team", issues: [], memberships: [member("lead", f.sessionA, "w1:p2", "lead"), member("builder", f.sessionB, "w1:p1", "teammate")] }],
					tasks: { "l1-team": { schema: "pi-team-tasks/1", teamName: "l1-team", availability: "available", issues: [], tasks: [{ id: "inspect", title: "Inspect file", status: "ready", owner: "builder", deps: [], ready: true }] } },
				}));
			},
			effects: () => ({ control: ctl.requests, submissions: ctl.submissions, herdr: f.herdrCalls(), gaps: piBrowser!.gaps,
				askCalls: pi.arcCalls, allAskCalls: readArcCalls(), helperModels, askCommand, citationRoute: pi.citationRoute }) };
		drivers.push(pi);
		await ownerScenario(pi);
		await ownerScenario(durable);
		assert.equal(ctl.submissions.length, 2);
		assert.deepEqual(ctl.submissions.map(s => [s.deliverAs, s.state, s.text]), [["steer", "returned", "Inspect sample.txt"], ["followUp", "returned", "Check sample.txt"]]);
		// Read through the owning node object only to verify admissions; the hub remains the read boundary under test.
		const { conversation } = await daemon.runtime.thread(threadId);
		const nativeAdmissions = await conversation.commit(tx => Promise.all(["l1-steer", "l1-queue"].map(id => tx.submissionByRequest(conversation.id, id))), BACKGROUND_CONTEXT);
		assert.ok(nativeAdmissions.every(record => record !== undefined), "both owner inputs have native admission records");
		writeFileSync(join(proof, "node-admissions-after-abort.json"), JSON.stringify(nativeAdmissions, null, 2));
		const left = canonicalCheckpoints(pi), right = canonicalCheckpoints(durable);
		assert.deepEqual(left.values.map(c => c.name), right.values.map(c => c.name));
		const panelShapes = Object.fromEntries([left, right].map((side, i) => [i ? "durable" : "pi", teamPanelShape(side.values.find(c => c.name === "team")!.value)]));
		writeFileSync(join(proof, "team-panel-shapes.json"), JSON.stringify(panelShapes, null, 2));
		const teamReference = structuredClone(pi.checkpoints.find(c => c.name === "team")!.value);
		const renamed = structuredClone(teamReference); renamed.teams[0].tasks[0].title = "Different title";
		assert.deepEqual(teamPanelShape(teamReference), teamPanelShape(renamed), "Team comparison does not claim value parity");
		for (const mutate of [(v: any) => { v.teams[0].tasks = []; }, (v: any) => { v.teams[0].tasks[0].ready = "true"; }, (v: any) => { delete v.teams[0].tasks[0].title; }]) {
			const changed = structuredClone(teamReference); mutate(changed);
			assert.ok(differences(teamPanelShape(teamReference), teamPanelShape(changed)).length, "missing tasks, missing fields and wrong types remain visible");
		}
		const sourceHistory = [pi, durable].map(d => d.checkpoints.find(c => c.name === "find-open")?.value);
		const entryRanges = completeEntryRanges(sourceHistory);
		const compared = left.values.flatMap((checkpoint, index) => checkpointDifferences(checkpoint.name === "team" ? teamPanelShape(checkpoint.value) : checkpoint.value,
			checkpoint.name === "team" ? teamPanelShape(right.values[index].value) : right.values[index].value, checkpoint.name, durable.readerRange, entryRanges).map(delta => ({
			...delta, comparison: checkpoint.name === "team" ? "panel-field-shape" : citationCheckpoint(checkpoint.name) ? "parsed-citation-body" : "value",
			owner: checkpoint.name === "arc-built" && (terminalEntryPath(delta.path) || terminalClockPath(delta.path) || derivedHashPath(delta)) ? "verifier"
				: ["citation", "citation-web", "arc-build", "arc-built", "team"].includes(checkpoint.name) || (checkpoint.name === "fleet-search" && delta.path === "/value/hostStatus") ? "node-builder" : checkpoint.name === "after-abort" && delta.path === "/live/run" && pi.readiness?.some(r => r.status === "not-settled") ? "verifier"
				: ["overview", "steer", "queue", "abort"].includes(checkpoint.name) || /^\/(live|inbox)(\/|$)/.test(delta.path) ? "node-builder" : "reader-builder",
			piEvidence: { checkpoints: "pi/checkpoints.json", frames: "pi/frames.jsonl", throughFrame: pi.checkpoints[index].frameEnd },
			durableEvidence: { checkpoints: "durable/checkpoints.json", frames: "durable/frames.jsonl", throughFrame: durable.checkpoints[index].frameEnd },
		})));
		accepted = compared.flatMap(delta => { const rule = acceptedRule(delta); return rule ? [{ ...delta, status: rule.status, rule: rule.name, reason: rule.reason }] : []; });
		findings = compared.filter(delta => !acceptedRule(delta));
		// Accepted extras must not conceal a changed activity, a sibling field, or an unrelated field with the same name.
		for (const path of ["/live/run/activity", "/live/unexpected", "/agent/generation", "/usage/contextWindow", "/agent/via"]) {
			assert.equal(acceptedRule({ checkpoint: "session", path, pi: { absent: true }, durable: "failed" }), undefined, path);
		}
		assert.equal(acceptedRule({ checkpoint: "steer", path: "/via", pi: "control", durable: "unexpected" }), undefined);
		assert.equal(acceptedRule({ checkpoint: "overview", path: "/backend", pi: "pi", durable: { absent: true } }), undefined, "missing backend remains open");
		assert.equal(acceptedRule({ checkpoint: "overview", path: "/threads/<thread-a>/ref", pi: "devbox/pi:sess-a", durable: "devbox/pi-durable:rabc123.3" })?.name, "source-reference");
		for (const durable of [{ absent: true }, "other/pi-durable:rabc123.3", "devbox/pi:sess-b", "devbox/other:rabc123.3", "devbox/pi-durable:rabc123", "devbox/pi-durable:rabc123.0", "devbox/pi-durable:rabc123.no", "devbox/pi-durable:../3", "devbox/pi-durable:rabc123.3#entry"]) {
			assert.equal(acceptedRule({ checkpoint: "overview", path: "/threads/<thread-a>/ref", pi: "devbox/pi:sess-a", durable }), undefined, "only a same-host valid durable source reference is accepted");
		}
		for (const [checkpoint, path] of [["session", "/threads/<thread-a>/ref"], ["overview", "/usage/ref"]]) assert.equal(acceptedRule({ checkpoint, path, pi: "devbox/pi:sess-a", durable: "devbox/pi-durable:rabc123.3" }), undefined);
		assert.equal(acceptedRule({ checkpoint: "overview", path: "/threads/<thread-a>/ref", pi: "devbox/pi:sess-a#entry", durable: "devbox/pi-durable:rabc123.3" }), undefined, "entry fragments are not Overview source refs");
		for (const amount of ["$0", "$0.25", "<$0.01"]) {
			assert.equal(acceptedRule({ checkpoint: "overview", path: "/threads/<thread-a>/spendLabel", pi: `${amount}${historySuffix}`, durable: amount })?.name, "spend-coverage-suffix");
		}
		assert.equal(acceptedRule({ checkpoint: "overview", path: "/threads/<thread-a>/spendLabel", pi: `no price reported${historySuffix}`, durable: "no price reported" }), undefined, "a no-price label carries no suffix");
		const piSpend = { threads: { "<thread-a>": { spendLabel: `$0.25${historySuffix}` } } };
		for (const row of [{}, { spendLabel: "$0.26" }, { spendLabel: "no price reported" }]) {
			const deltas = differences(piSpend, { threads: { "<thread-a>": row } }).map(d => ({ checkpoint: "overview", ...d }));
			assert.equal(deltas.filter(d => !acceptedRule(d)).length, 1, "missing durable label, different amount and no-price mismatch remain open");
		}
		const spendRow = (spend: unknown) => ({ threads: { "<thread-a>": { spend } } });
		for (const usd of [0, 0.25, null]) {
			const deltas = checkpointDifferences(spendRow(historySpend(usd)), spendRow({ usd, covers: [...ALL_COVERS] }), "overview");
			assert.ok(deltas.length > 0);
			assert.ok(deltas.every(d => acceptedRule(d)?.name === "spend-coverage-suffix"), "exact coverage with equal priced or no-price amounts is accepted");
		}
		const piAmount = spendRow(historySpend(0.25));
		for (const spend of [undefined, { usd: 0.26, covers: [...ALL_COVERS] }, { covers: [...ALL_COVERS] }, { usd: null, covers: [...ALL_COVERS] },
			{ usd: 0.25, covers: ["responses", "compaction", "tools"] }, { usd: 0.25, covers: [...ALL_COVERS, "unknown"] }]) {
			const deltas = checkpointDifferences(piAmount, spendRow(spend), "overview");
			assert.ok(deltas.length > 0);
			assert.ok(deltas.every(d => !acceptedRule(d)), "missing spend/usd, changed usd and inexact coverage stay open, including coverage leaves");
		}
		const missingAmounts = checkpointDifferences(spendRow({ covers: [...HISTORY_COVERS] }), spendRow({ covers: [...ALL_COVERS] }), "overview");
		assert.ok(missingAmounts.every(d => !acceptedRule(d)), "two missing amounts cannot establish equal usd");
		assert.equal(acceptedRule({ checkpoint: "overview", path: "/threads/<thread-a>/spend/covers/2", pi: { absent: true }, durable: "compaction" }), undefined, "a coverage leaf needs full spend context");
		const badPiCoverage = checkpointDifferences(spendRow({ usd: 0.25, covers: ["responses"] }), spendRow({ usd: 0.25, covers: [...ALL_COVERS] }), "overview");
		assert.ok(badPiCoverage.every(d => !acceptedRule(d)), "Pi coverage must equal HISTORY_COVERS");
		const siblings = checkpointDifferences(piAmount, spendRow({ usd: 0.25, covers: [...ALL_COVERS], unexpected: true, mixed: true }), "overview");
		assert.deepEqual(siblings.filter(d => !acceptedRule(d)).map(d => d.path), ["/threads/<thread-a>/spend/unexpected", "/threads/<thread-a>/spend/mixed"], "unknown and sibling spend fields remain visible");
		for (const checkpoint of ["session", "queued-view"]) {
			assert.ok(checkpointDifferences(piAmount, spendRow({ usd: 0.25, covers: [...ALL_COVERS] }), checkpoint).every(d => !acceptedRule(d)), "structured rule stays within Overview");
		}
		assert.equal(acceptedRule({ checkpoint: "overview", path: "/usage/spend/covers/2", pi: { absent: true }, durable: "compaction", spendCoverage: { pi: historySpend(0.25), durable: { usd: 0.25, covers: [...ALL_COVERS] } } }), undefined, "unrelated coverage path remains open");
		for (const [checkpoint, path] of [["session", "/threads/<thread-a>/spendLabel"], ["overview", "/usage/spendLabel"]]) {
			assert.equal(acceptedRule({ checkpoint, path, pi: `$0.25${historySuffix}`, durable: "$0.25" }), undefined, "coverage rule stays within Overview thread spend labels");
		}
		assert.ok(differences({ activity: "idle", queued: 0 }, { activity: "failed", queued: 1 }).length === 2, "semantic state changes survive comparison");
		const mutatedDriver = { ...pi, checkpoints: structuredClone(pi.checkpoints) };
		mutatedDriver.checkpoints[0].value.unexpected = "negative control";
		mutatedDriver.checkpoints[0].value.threads[pi.threadId].queued = 999;
		const mutation = canonicalCheckpoints(mutatedDriver).values;
		assert.ok(differences(left.values, mutation).some(d => d.path.includes("unexpected")), "unknown fields survive normalization and comparison");
		assert.ok(differences(left.values, mutation).some(d => d.path.endsWith("/queued")), "queue state survives normalization and comparison");
		for (const [driver, canonical] of [[pi, left], [durable, right]] as const) {
			mkdirSync(join(proof, driver.backend), { recursive: true });
			writeFileSync(join(proof, driver.backend, "normalized.json"), JSON.stringify(canonical, null, 2));
		}
	} catch (e) { error = String(e); throw e; }
	finally {
		for (const driver of drivers) {
			mkdirSync(join(proof, driver.backend), { recursive: true });
			writeFileSync(join(proof, driver.backend, "frames.jsonl"), driver.frames.map(line).join(""));
			writeFileSync(join(proof, driver.backend, "checkpoints.json"), JSON.stringify(driver.checkpoints, null, 2));
			writeFileSync(join(proof, driver.backend, "effects.json"), JSON.stringify(driver.effects(), null, 2));
			writeFileSync(join(proof, driver.backend, "readiness.json"), JSON.stringify(driver.readiness ?? [], null, 2));
		}
		await cleanupPi?.(); await cleanupDurable?.();
		writeFileSync(join(proof, "findings.json"), JSON.stringify(findings, null, 2));
		writeFileSync(join(proof, "accepted.json"), JSON.stringify(accepted, null, 2));
		const afterSources = sourceHashes();
		const wallMs = Math.round(performance.now() - started);
		writeFileSync(join(proof, "receipt.json"), JSON.stringify({ schema: "ampi-durable-l1-paired/1", captureStatus: error ? "failed" : "complete", error,
			parity: error ? "not-compared" : findings.length ? "differences" : "matched-supported-checkpoints", findings: findings.length, openByOwner: Object.fromEntries(["node-builder", "reader-builder", "verifier"].map(owner => [owner, findings.filter(f => f.owner === owner).length])),
			checkpointReadiness: drivers.map(d => ({ backend: d.backend, checkpoints: d.readiness ?? [] })),
			accepted: accepted.length, compared: findings.length + accepted.length,
			acceptedRules: acceptedNormalizationRules.map(({ matches: _matches, ...rule }) => rule), comparisonModes: { default: "value", team: "panel-field-shape", citation: "parsed-citation-body", "citation-web": "parsed-citation-body" },
			wallMs, apiSpendUsd: 0, revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
			dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().split("\n"), beforeSources, afterSources,
			sourcesStable: JSON.stringify(beforeSources) === JSON.stringify(afterSources),
			backends: drivers.map(d => ({ backend: d.backend, frames: d.frames.length, checkpoints: d.checkpoints.map(c => c.name), gaps: d.browser.gaps })),
			evidenceClass: "real hub and durable node; scripted offline provider; Pi JSONL and fake control/Herdr. Control fixture cannot prove real Pi model placement or cancellation behavior.",
			cleanup: "WebSockets, hubs, node and control listener closed; temporary stores removed",
		}, null, 2));
		console.log(`L1 paired ${error ? "CAPTURE FAILED" : "CAPTURED"}: ${wallMs} ms; ${findings.length} open differences; ${accepted.length} accepted; proof ${proof}`);
	}
});
