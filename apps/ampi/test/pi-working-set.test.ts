import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WorkingSet } from "../src/pi/working-set.ts";
import type { FindAsk } from "../src/pi/search.ts";
import { openWorkingSet, readWorkingSet } from "../src/pi/working-set-db.ts";
import { type Source, TOOL_ARGS_CHARS } from "../src/pi/working-set-types.ts";
import { selectRarebits, measureRarebits } from "@hypercarrier/rarebit/core";
const line = (o: unknown) => JSON.stringify(o) + "\n";
const msg = (id: string, parentId: string | null, text: string, role = "user") => ({ type: "message", id, parentId, timestamp: new Date(1_770_000_000_000 + Number(id.replace(/\D/g, "")) * 1000).toISOString(), message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { stopReason: "stop", usage: { input: 20, output: 10, cost: { total: 0.1 } } } : {}) } });
/** `own` closes another WorkingSet on the same cache before the directory goes; an open one writes into it. */
function setup(t: { after(fn: () => void): void }, records: any[]) {
 const dir = mkdtempSync(join(tmpdir(), "ampi-working-set-"));
 const source: Source = { host: "fixture", cacheDir: join(dir, "cache"), path: "/synthetic/session.jsonl", file: join(dir, "copy.jsonl") };
 mkdirSync(source.cacheDir);
 writeFileSync(source.file, line({ type: "session", id: "fixture-session", cwd: "/synthetic", timestamp: "2026-01-01T00:00:00Z" }) + records.map(line).join(""));
 const store = new WorkingSet(source.host, source.cacheDir), owned = [store];
 t.after(async () => { for (const set of owned) await set.close(); rmSync(dir, { recursive: true, force: true }); });
 return { source, store, own: (set: WorkingSet) => (owned.push(set), set) };
}

test("working set: tail limits cannot truncate full-branch statistics, Rarebit snapshots or exact Timeline navigation", async (t) => {
 const records = Array.from({ length: 650 }, (_, i) => msg(`e${i}`, i ? `e${i - 1}` : null, `prose ${i} ` + "x".repeat(1500), i % 2 ? "assistant" : "user"));
 const { source, store } = setup(t, records);
 const data = (await store.refresh(source))!;
 const page = store.tail(source, data, false);
 assert.ok(page.entries.length <= 400); assert.ok(page.more);
 assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024);
 assert.equal(data.count, 650); assert.equal(data.timeline.entryCount, 650);
 assert.equal(data.timeline.entries.length, 64); assert.equal(data.timeline.omittedHints, 586);
 assert.equal(store.nearest(source.path, Date.parse(records[50]!.timestamp)), "e50");
 const around = store.page(source.path, { around: "e50", version: data.version });
 assert.ok(around.entries.some((e) => e.id === "e50"));
 const expected = measureRarebits(records, selectRarebits(records));
 assert.equal(data.rarebit.stats.rarebitTokens, expected.estimatedRarebitTokens);
 assert.equal(data.rarebit.stats.totalTokens, expected.estimatedTotalTokens);
 assert.equal(data.rarebit.stats.user + data.rarebit.stats.stop, 650);
 const snapshot = store.rarebitSnapshot(source.path, 100_000);
 assert.equal(snapshot.count, 650); assert.ok(snapshot.omittedChars > 0); assert.equal(snapshot.context.length, 100_000);
 assert.ok(data.arc.chunks.some((c) => c.firstEntryId === "e0"));
});

test("working set: an around page always holds its target, and the Rarebit page of a linked entry holds its item", async (t) => {
 const records = Array.from({ length: 650 }, (_, i) => msg(`e${i}`, i ? `e${i - 1}` : null, `prose ${i} ` + "x".repeat(1500), i % 2 ? "assistant" : "user"));
 const { source, store } = setup(t, records);
 const data = (await store.refresh(source))!;
 // Later rows used to fill a small page from above and push the target out (nav-anchors, systems observer).
 const small = store.page(source.path, { around: "e50", limit: 10, version: data.version });
 assert.ok(small.entries.some((e) => e.id === "e50"), "the target is in the page");
 assert.equal(small.entries.length, 10); assert.ok(small.more);
 for (let i = 1; i < small.entries.length; i++) assert.ok(Number(small.entries[i]!.id.slice(1)) === Number(small.entries[i - 1]!.id.slice(1)) + 1, "contiguous rows");
 // The newest Rarebit page (400 items) does not hold e50; an around read serves the page that does, and its cursor.
 assert.ok(!store.rarebits(source.path, 1).items.some((i) => i.id === "e50"));
 const page = store.rarebits(source.path, 1, undefined, false, "e50");
 assert.ok(page.items.some((i) => i.id === "e50")); assert.deepEqual(page.around, { id: "e50", found: "item" }); assert.ok(page.before);
 assert.deepEqual(store.rarebits(source.path, 1, undefined, false, "e640").before, undefined, "a recent target is on the newest page");
 assert.deepEqual(store.rarebits(source.path, 1, undefined, false, "nope").around, { id: "nope", found: "missing" });
});

test("working set: the hub's reader waits out a briefly held write lock instead of failing (\"database is locked\" at load 211)", async (t) => {
 const dir = mkdtempSync(join(tmpdir(), "ampi-working-set-lock-"));
 t.after(() => rmSync(dir, { recursive: true, force: true }));
 openWorkingSet(dir).close();
 // Another process takes the exclusive lock, as the Worker's last close does to checkpoint the WAL.
 const holder = spawn(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(${JSON.stringify(join(dir, "working-set.sqlite"))});
db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN IMMEDIATE; INSERT INTO sessions VALUES ('held','{}'); COMMIT;");
console.log("locked");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
db.close();`], { stdio: ["ignore", "pipe", "inherit"] });
 await once(holder.stdout!, "data");
 const started = performance.now();
 const db = readWorkingSet(dir);
 try { assert.equal(Number(db.prepare("SELECT count(*) AS n FROM sessions").get()!.n), 1); }
 finally { db.close(); }
 assert.ok(performance.now() - started >= 100, "the reader opened while the lock was still held");
 await once(holder, "exit");
});

test("working set: the derive Worker completes an old cache's prose_path backfill while serving jobs", async (t) => {
 const dir = mkdtempSync(join(tmpdir(), "ampi-working-set-"));
 const source: Source = { host: "fixture", cacheDir: join(dir, "cache"), path: "/synthetic/session.jsonl", file: join(dir, "copy.jsonl") };
 mkdirSync(source.cacheDir);
 const old = new DatabaseSync(join(source.cacheDir, "working-set.sqlite"));
 old.exec("CREATE VIRTUAL TABLE prose USING fts5(path UNINDEXED, id UNINDEXED, text, cjk, tokenize='unicode61'); BEGIN");
 for (let i = 0; i < 5000; i++) old.prepare("INSERT INTO prose(path,id,text,cjk) VALUES (?,?,?,?)").run("/synthetic/old.jsonl", `e${i}`, `legacy ${i}`, "");
 old.exec("COMMIT"); old.close();
 writeFileSync(source.file, line({ type: "session", id: "fixture-session", cwd: "/synthetic", timestamp: "2026-01-01T00:00:00Z" }) + line(msg("e0", null, "freshneedle")));
 const store = new WorkingSet(source.host, source.cacheDir);
 t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
 assert.ok(await store.refresh(source));
 const count = (sql: string) => Number(store.db.prepare(sql).get()!.n);
 for (let i = 0; i < 100 && count("SELECT count(*) AS n FROM prose_path_backfill"); i++) await new Promise((r) => setTimeout(r, 50));
 assert.equal(count("SELECT count(*) AS n FROM prose_path_backfill"), 0);
 assert.equal(count("SELECT count(*) AS n FROM prose_path"), 5001);
 assert.equal(store.search("freshneedle").hits.length, 1);
});

test("working set: fork/reset invalidates old pages, prose hits and body references even at equal source length", async (t) => {
 const { source, store } = setup(t, [msg("e0", null, "oldneedle"), msg("e1", "e0", "discardedneedle")]);
 const original = (await store.refresh(source))!;
 appendFileSync(source.file, line(msg("e2", "e0", "newneedle")));
 const fork = (await store.refresh(source))!;
 assert.equal(fork.count, 2); assert.equal(store.search("discardedneedle").hits.length, 0);
 // A moved version is retryable and an entry off the branch is final; the wire carries the code (protocol.ts).
 assert.throws(() => store.page(source.path, { version: original.version }), { code: "stale_version", message: /changed/ });
 assert.throws(() => store.page(source.path, { around: "e1", version: fork.version }), { code: "not_found", message: /current branch/ });
 assert.throws(() => store.entry(source, "e1"), { code: "not_found", message: /current branch/ });
 assert.throws(() => store.entry(source, "e2", 0, original.version), { code: "stale_version", message: /changed/ });
 const page = store.entry(source, "e2", 0, fork.version);
 assert.equal(page.more, false); assert.equal(JSON.parse(page.text).text, "newneedle");
 writeFileSync(source.file, line({ type: "session", id: "fixture-session" }) + line(msg("e3", null, "samelengthA")));
 const a = (await store.refresh(source))!;
 writeFileSync(source.file, line({ type: "session", id: "fixture-session" }) + line(msg("e3", null, "samelengthB")));
 const b = (await store.refresh(source))!;
 assert.equal(a.bytes, b.bytes); assert.notEqual(a.version, b.version);
 assert.equal(store.search("samelengthA").hits.length, 0); assert.equal(store.search("samelengthB").hits.length, 1);
});

test("search: fleet CJK bigrams find two characters and exclude thinking/tools; Session find streams every entry kind", async (t) => {
 const records: any[] = [msg("e0", null, "你好世界 alpha"), msg("e1", "e0", "reply alpha", "assistant")];
 records[1].message.content.push({ type: "thinking", thinking: "thoughtneedle" }, { type: "toolCall", name: "bash", id: "call", arguments: { command: "argumentneedle" } });
 records.push(msg("e2", "e1", "resultneedle", "toolResult"));
 records.push({ type: "message", id: "e3", parentId: "e2", message: { role: "bashExecution", command: "commandneedle", output: "outputneedle" } });
 records.push({ type: "custom_message", id: "e4", parentId: "e3", customType: "notice", content: "customneedle" });
 records.push({ type: "compaction", id: "e5", parentId: "e4", summary: "compactneedle" });
 records.push({ type: "branch_summary", id: "e6", parentId: "e5", summary: "branchneedle" });
 const { source, store } = setup(t, records);
 const data = (await store.refresh(source))!;
 assert.equal(store.search("你好").hits[0]?.entry, "e0");
 assert.equal(store.search("世界").hits[0]?.entry, "e0");
 assert.equal(store.search("alpha").hits.length, 2);
 assert.throws(() => store.search("你"), /two adjacent CJK/);
 for (const q of ["thoughtneedle", "argumentneedle", "resultneedle", "commandneedle", "outputneedle", "customneedle", "branchneedle"]) assert.equal(store.search(q).hits.length, 0, q);
 assert.equal(store.search("compactneedle").hits[0]?.entry, "e5");
 for (const q of ["THOUGHTNEEDLE", "argumentneedle", "resultneedle", "commandneedle", "outputneedle", "customneedle", "compactneedle", "branchneedle", "好世"]) {
  const found = await store.find(source, q, data.version);
  assert.equal(found.total, 1, q); assert.equal(found.scanned, records.length); assert.match(found.scope, /inactive branches/);
  assert.ok(found.hits[0]?.ref.startsWith("fixture/pi:fixture-session#"));
 }
 await store.forget(source); assert.equal(store.search("alpha").hits.length, 0); assert.equal(store.load(source.path), undefined);
});

test("search: Session find keeps one window of at most 200 matches per scope near `from` or the tail, echoes `anchored`, and old clients keep the first 200", async (t) => {
 // e0–e599 match in prose, e600 does not, t601–t650 match only in tool results.
 const records: any[] = Array.from({ length: 600 }, (_, i) => msg(`e${i}`, i ? `e${i - 1}` : null, `needle ${i}`, i % 2 ? "assistant" : "user"));
 records.push(msg("e600", "e599", "plain"));
 for (let i = 601; i <= 650; i++) records.push(msg(`t${i}`, i === 601 ? "e600" : `t${i - 1}`, `needle ${i}`, "toolResult"));
 const { source, store } = setup(t, records);
 const data = (await store.refresh(source))!;
 const find = async (ask: FindAsk = {}) => {
  const found = await store.find(source, "needle", data.version, ask);
  assert.equal(found.total, 650); assert.equal(found.proseTotal, 600); assert.ok(found.more);
  const ids = (scope: "all" | "prose") => { const w = found.windows![scope]; return found.hits.filter((h) => (scope === "all" || h.prose) && h.at! >= w.first && h.at! <= w.last).map((h) => h.entry); };
  return { found, all: ids("all"), prose: ids("prose"), w: found.windows! };
 };
 const span = (from: number, to: number, p = "e") => Array.from({ length: to - from + 1 }, (_, i) => `${p}${from + i}`);
 // No `from` gives the first window and no `anchored`; a `from` the copy lacks gives it with `anchored: false`.
 for (const [ask, anchored] of [[{}, undefined], [{ from: "missing" }, false]] as const) {
  const { found, all, w } = await find(ask);
  assert.deepEqual(all, span(0, 199)); assert.deepEqual(w.all, { first: found.hits[0]!.at, last: found.hits[199]!.at, skipped: 0, start: 0, size: 200 });
  assert.equal(found.hits.length, 200); assert.equal(found.anchored, anchored);
 }
 // In the middle, 100 matches lie behind `from`; the window's start is `from` itself.
 let r = await find({ from: "e500" });
 assert.equal(r.found.anchored, true);
 assert.deepEqual(r.prose, span(400, 599)); assert.deepEqual({ skipped: r.w.prose.skipped, start: r.w.prose.start, size: r.w.prose.size }, { skipped: 400, start: 100, size: 200 });
 assert.deepEqual(r.all, [...span(400, 599)]); assert.equal(r.w.all.skipped, 400);
 // Near the start, the window cannot hold 100 behind.
 r = await find({ from: "e30" });
 assert.deepEqual(r.prose, span(0, 199)); assert.equal(r.w.prose.start, 30); assert.equal(r.w.prose.skipped, 0);
 // Near the end, the window holds more behind; with no prose match after `from`, prose starts past its window.
 r = await find({ from: "e600" });
 assert.deepEqual(r.all, [...span(450, 599), ...span(601, 650, "t")]); assert.deepEqual({ skipped: r.w.all.skipped, start: r.w.all.start }, { skipped: 450, start: 150 });
 assert.deepEqual(r.prose, span(400, 599)); assert.deepEqual({ skipped: r.w.prose.skipped, start: r.w.prose.start, size: r.w.prose.size }, { skipped: 400, start: 200, size: 200 });
 assert.equal(r.found.hits.length, 250);
 // The tail holds each scope's last 200 matches; no match lies after the reader, so `start` is the window's size.
 r = await find({ tail: true });
 assert.equal(r.found.anchored, true);
 assert.deepEqual(r.all, [...span(450, 599), ...span(601, 650, "t")]); assert.deepEqual({ skipped: r.w.all.skipped, start: r.w.all.start, size: r.w.all.size }, { skipped: 450, start: 200, size: 200 });
 assert.deepEqual(r.prose, span(400, 599)); assert.deepEqual({ skipped: r.w.prose.skipped, start: r.w.prose.start }, { skipped: 400, start: 200 });
});

test("working set: repeated 32-Session churn plateaus heap/external bytes and releases every LRU reference on close", () => {
 const result = JSON.parse(execFileSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("./pi-window-churn-fixture.ts", import.meta.url))], { encoding: "utf8", timeout: 60_000 }));
 assert.equal(result.usage.lruSlots, 20);
 assert.ok(result.usage.lruBytes <= 64 * 1024 * 1024);
 const first = result.samples[2], last = result.samples.at(-1);
 assert.ok(last.heapUsed - first.heapUsed < 4 * 1024 * 1024, JSON.stringify(result.samples));
 assert.ok(last.external - first.external < 1024 * 1024, JSON.stringify(result.samples));
 assert.deepEqual(result.closed, { liveBytes: 0, lruBytes: 0, liveSlots: 0, lruSlots: 0 });
});

test("working set: large tool output remains a bounded preview and its projected entry pages stay below 64 KiB", async (t) => {
 const record = msg("e0", null, "你好🌟".repeat(100000), "toolResult");
 const { source, store } = setup(t, [record]);
 const data = (await store.refresh(source))!;
 const entry: any = store.tail(source, data, true).entries[0];
 assert.ok(entry.text.length <= 256); assert.equal(entry.clipped, true); assert.ok(!entry.bodyAvailable);
 assert.equal(entry.clippedBytes, Buffer.byteLength(record.message.content[0]!.text));
 let offset = 0, text = "", pages = 0, page;
 do { page = store.entry(source, "e0", offset, data.version); assert.ok(Buffer.byteLength(page.text) <= 65536); text += page.text; offset = page.next; pages++; } while (page.more);
 const full = JSON.parse(text);
 assert.ok(pages > 1); assert.deepEqual(Object.keys(full).sort(), ["callId", "id", "isError", "kind", "name", "text", "truncated", "ts"]);
 assert.equal(full.text, record.message.content[0]!.text.slice(0, full.text.length)); assert.equal(full.truncated, true);
});

test("working set: derive survives assistant usage with null cost, missing cost, or no usage, and totals skip them", async (t) => {
 const turn = (id: string, parentId: string, usage: unknown) => { const m = msg(id, parentId, `reply ${id}`, "assistant"); return { ...m, message: { ...m.message, usage } }; };
 const records = [msg("e0", null, "start"), turn("e1", "e0", { input: 20, output: 10, cost: null }), msg("e2", "e1", "next"),
  turn("e3", "e2", { input: 20, output: 10 }), msg("e4", "e3", "again"), turn("e5", "e4", undefined), msg("e6", "e5", "last"),
  turn("e7", "e6", { input: 20, output: 10, cost: { total: 0.25 } })];
 const { source, store } = setup(t, records);
 const data = (await store.refresh(source))!;
 assert.equal(data.count, 8);
 assert.equal(data.cost, 0.25);
});

test("working set: the preview flags only clipped visible prose; tool args and thinking shorten in place", async (t) => {
 const turn = (id: string, parentId: string | null, content: unknown[]) => { const m = msg(id, parentId, "", "assistant"); return { ...m, message: { ...m.message, content } }; };
 const records = [
  msg("e0", null, "short ask"),
  turn("e1", "e0", [{ type: "text", text: "Short answer." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]),
  turn("e2", "e1", [{ type: "thinking", thinking: "t".repeat(5000) }, { type: "text", text: "Done." }, { type: "toolCall", id: "c2", name: "write", arguments: { path: "/synthetic/a.txt", content: "x".repeat(9000) } }]),
  turn("e3", "e2", [{ type: "text", text: "p".repeat(20_000) }]),
  turn("e4", "e3", [{ type: "toolCall", id: "c4", name: "read", arguments: { paths: Array.from({ length: 100 }, (_, i) => `/synthetic/${i}/${"p".repeat(200)}`) } }]),
 ];
 const { source, store } = setup(t, records);
 const data = (await store.refresh(source))!;
 const [user, small, hidden, long, many]: any[] = store.tail(source, data, true).entries;
 assert.ok(!user.bodyAvailable, "a short user message has no disclosure");
 assert.ok(!small.bodyAvailable, "a tool call alone does not mark a short message shortened");
 assert.deepEqual(small.blocks[1].args, { summary: "ls", command: "ls" });
 assert.ok(!hidden.bodyAvailable, "large tool args and long thinking do not mark visible prose shortened");
 assert.equal(hidden.blocks[0].clipped, true); assert.ok(hidden.blocks[0].text.length < 5000);
 assert.equal(hidden.blocks[2].argsClipped, true); assert.deepEqual(hidden.blocks[2].args, { summary: "/synthetic/a.txt · 1 lines", path: "/synthetic/a.txt", omitted: { content: true } });
 assert.equal(long.bodyAvailable, true, "clipped prose keeps the disclosure");
 const row = many.blocks[0];
 assert.equal(row.argsClipped, true);
 assert.ok(JSON.stringify(row.args).length <= TOOL_ARGS_CHARS, "a stored row's tool args stay within the bound");
 assert.equal(row.args.paths.length + row.args.omitted.paths, 100);
});

test("working set: tool results, custom entries and compaction summaries shorten in place; only clipped prose keeps the row disclosure", async (t) => {
 const records = [
  msg("e0", null, "u".repeat(20_000)),
  msg("e1", "e0", "o".repeat(600), "toolResult"),
  msg("e2", "e1", "short output", "toolResult"),
  { type: "custom_message", id: "e3", parentId: "e2", customType: "notice", content: "c".repeat(2000) },
  { type: "compaction", id: "e4", parentId: "e3", summary: "s".repeat(1500) },
  { type: "branch_summary", id: "e5", parentId: "e4", summary: "b".repeat(1500) },
  { type: "custom_message", id: "e6", parentId: "e5", customType: "notice", content: "short notice" },
 ];
 const { source, store } = setup(t, records);
 const data = (await store.refresh(source))!;
 const [user, tool, small, custom, compaction, branch, notice]: any[] = store.tail(source, data, true).entries;
 assert.equal(user.bodyAvailable, true, "clipped user prose keeps the row disclosure");
 for (const [name, entry, text, kept, bytes] of [["tool result", tool, tool.text, 256, 600], ["custom entry", custom, custom.message.text, 1024, 2000], ["compaction summary", compaction, compaction.summary, 1024, 1500], ["branch summary", branch, branch.summary, 1024, 1500]] as const) {
  await t.test(name, () => {
   assert.ok(!entry.bodyAvailable, `${entry.kind} ${entry.id} has no row disclosure`);
   assert.equal(entry.clipped, true); assert.equal(entry.clippedBytes, bytes); assert.equal(text.length, kept);
  });
 }
 assert.equal(tool.truncated, true);
 for (const entry of [small, notice]) assert.ok(!entry.bodyAvailable && !entry.clipped, entry.id);
 assert.equal(small.truncated, false);
});

test("working set: user and assistant prose up to 16 KiB stay whole in the preview; longer prose keeps the row disclosure", async (t) => {
 // 13,616 chars was the longest live message when the preview cut prose at 1,024 (A24).
 const records = [msg("e0", null, "u".repeat(13_616)), msg("e1", "e0", "a".repeat(13_616), "assistant"), msg("e2", "e1", "l".repeat(20_000), "assistant")];
 const { source, store } = setup(t, records);
 const data = (await store.refresh(source))!;
 const [user, assistant, long]: any[] = store.tail(source, data, true).entries;
 assert.equal(user.text.length, 13_616); assert.ok(!user.bodyAvailable, "a 13,616-char user message is whole");
 assert.equal(assistant.blocks[0].text.length, 13_616); assert.ok(!assistant.bodyAvailable, "a 13,616-char reply is whole");
 assert.equal(long.blocks[0].text.length, 16 * 1024); assert.equal(long.bodyAvailable, true);
});

test("working set: a Rarebit page cuts long texts in SQLite and equals the whole-row parse; fullText keeps them whole", async (t) => {
 // Astral characters make the SQLite cut (code points) and the page cut (UTF-16 units) differ.
 const astral = "é🙂".repeat(6000) + "z".repeat(100), plain = "p".repeat(9000), short = "short";
 const records = [msg("e0", null, astral), msg("e1", "e0", plain, "assistant"), msg("e2", "e1", short)];
 const { source, store } = setup(t, records);
 await store.refresh(source);
 const db = new DatabaseSync(join(source.cacheDir, "working-set.sqlite"), { readOnly: true });
 t.after(() => db.close());
 const whole = db.prepare("SELECT rarebit FROM entries WHERE path=? AND rarebit IS NOT NULL ORDER BY position").all(source.path).map((row: any) => JSON.parse(String(row.rarebit)));
 const expected = whole.map((item: any) => item.text.length > 8192 ? { ...item, text: item.text.slice(0, 8192), truncated: true } : item);
 const page = store.rarebits(source.path, 1);
 assert.deepEqual(page.items.map((i) => i.text.length), [8192, 8192, short.length]);
 assert.deepEqual(page.items, expected, "the page equals the old JS cut of each whole row");
 assert.deepEqual(store.rarebits(source.path, 1, undefined, true).items, whole, "fullText keeps every text whole");
});

test("working set: saved heads are readable before the derive Worker initializes, so a restart lists Sessions sooner", async (t) => {
 const { source, store, own } = setup(t, [msg("e1", null, "saved prose")]);
 const saved = (await store.refresh(source))!;
 store.close();
 const restarted = own(new WorkingSet(source.host, source.cacheDir));
 let initialized = false;
 void restarted.ready.then(() => { initialized = true; });
 await restarted.readable;
 assert.equal(initialized, false);
 assert.equal(restarted.load(source.path)?.version, saved.version);
 await restarted.ready;
});

test("working set: a saved head of another derivation version is not served before its re-derive (wire-boundary.md, mixed-version index)", async (t) => {
 const { source, store, own } = setup(t, [msg("e1", null, "stalehead prose")]);
 const saved = (await store.refresh(source))!;
 assert.deepEqual(store.search("stalehead").hits.map((h) => h.entry), ["e1"]);
 store.close();
 const db = new DatabaseSync(join(source.cacheDir, "working-set.sqlite"));
 try { db.prepare("UPDATE sessions SET data=? WHERE path=?").run(JSON.stringify({ ...saved, version: `5:${saved.version.split(":").slice(1).join(":")}` }), source.path); }
 finally { db.close(); }
 const restarted = own(new WorkingSet(source.host, source.cacheDir));
 await restarted.readable;
 assert.equal(restarted.load(source.path), undefined);
 assert.throws(() => restarted.page(source.path), /not indexed yet/);
 const search = restarted.search("stalehead");
 assert.deepEqual([search.hits, search.coverage?.indexed], [[], 0]);
 const data = (await restarted.refresh(source))!;
 assert.equal(restarted.load(source.path)?.version, data.version);
 assert.deepEqual(restarted.page(source.path).entries.map((e) => e.id), ["e1"]);
 assert.deepEqual(restarted.search("stalehead").hits.map((h) => h.entry), ["e1"]);
});

/** The DERIVATION_VERSION before the whole-preview tool-args bound: its rows kept every path after clipping. */
const UNBOUNDED_ARGS_VERSION = 6;

test("working set: a row stored before the whole-preview bound re-derives within TOOL_ARGS_CHARS after a restart", async (t) => {
 const paths = Array.from({ length: 100 }, (_, i) => `/synthetic/${i}/${"p".repeat(200)}`);
 const m = msg("e1", null, "", "assistant");
 const { source, store } = setup(t, [{ ...m, message: { ...m.message, content: [{ type: "toolCall", id: "c1", name: "read", arguments: { paths } }] } }]);
 await store.refresh(source);
 store.close();
 // Rewrite the row as a version-6 build left it: argsClipped, every path kept, no omitted.
 const db = new DatabaseSync(join(source.cacheDir, "working-set.sqlite"));
 try {
  const row = db.prepare("SELECT ui FROM entries WHERE path=? AND id='e1'").get(source.path) as { ui: string };
  const ui = JSON.parse(row.ui);
  ui.blocks[0] = { ...ui.blocks[0], args: { summary: "", paths }, argsClipped: true };
  db.prepare("UPDATE entries SET ui=? WHERE path=? AND id='e1'").run(JSON.stringify(ui), source.path);
  const { data } = db.prepare("SELECT data FROM sessions WHERE path=?").get(source.path) as { data: string };
  const saved = JSON.parse(data);
  saved.version = `${UNBOUNDED_ARGS_VERSION}:${String(saved.version).split(":").slice(1).join(":")}`;
  db.prepare("UPDATE sessions SET data=? WHERE path=?").run(JSON.stringify(saved), source.path);
 } finally {
  db.close();
 }
 const restarted = new WorkingSet(source.host, source.cacheDir);
 t.after(() => restarted.close());
 const data = (await restarted.refresh(source))!;
 const args = (restarted.tail(source, data, true).entries[0] as any).blocks[0].args;
 assert.ok(JSON.stringify(args).length <= TOOL_ARGS_CHARS, `the stored row's tool args serialize to ${JSON.stringify(args).length} chars`);
 assert.equal(args.paths.length + args.omitted.paths, 100);
});

test("working set: a database without a sessions table waits for the Worker's schema", async (t) => {
 const dir = mkdtempSync(join(tmpdir(), "ampi-working-set-empty-"));
 new DatabaseSync(join(dir, "working-set.sqlite")).close();
 const store = new WorkingSet("fixture", dir);
 t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
 await store.readable;
 assert.equal(store.load("/synthetic/none.jsonl"), undefined);
});

/** A cache directory with one Session copy, outside `setup`'s Worker owner. */
function cache(t: { after(fn: () => void): void }, name: string) {
 const root = mkdtempSync(join(tmpdir(), `ampi-working-set-${name}-`));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const cacheDir = join(root, "cache"); mkdirSync(cacheDir);
 const source: Source = { host: name, cacheDir, path: "/synthetic/session.jsonl", file: join(cacheDir, "copy.jsonl") };
 writeFileSync(source.file, line({ type: "session", id: `${name}-session`, cwd: "/synthetic", timestamp: "2026-01-01T00:00:00Z" }) + line(msg("e1", null, "prose")));
 return source;
}
/**
 * Holds the cache's write lock, so a Worker job there waits in SQLite's busy handler.
 * Take it after one derive round trip: the store's first backfill step also writes.
 */
function lock(cacheDir: string) {
 const db = openWorkingSet(cacheDir); db.exec("BEGIN IMMEDIATE");
 return () => { db.exec("ROLLBACK"); db.close(); };
}
const files = (dir: string, pattern: RegExp) => readdirSync(dir).filter((name) => pattern.test(name));

test("working set: a closed store's queued init never recreates its cache while the Worker serves another store", async (t) => {
 const { source, store } = setup(t, [msg("e1", null, "prose")]);
 await store.ready;
 const closed = cache(t, "closed");
 const closing = new WorkingSet(closed.host, closed.cacheDir);
 await closing.close();
 assert.deepEqual(files(closed.cacheDir, /-(wal|shm)$/), [], "no WAL file outlives a resolved close");
 rmSync(closed.cacheDir, { recursive: true });
 // Jobs run in rank order, so this init or derive round trip passes every job queued before it.
 assert.ok(await store.refresh(source));
 assert.equal(existsSync(closed.cacheDir), false, "the Worker wrote the closed cache after close resolved");
});

test("working set: close during an active derive answers after the job closes its database and refuses queued work", async (t) => {
 const { store } = setup(t, []);
 await store.ready;
 const source = cache(t, "active"), second = { ...source, path: "/synthetic/second.jsonl" };
 const closing = new WorkingSet(source.host, source.cacheDir);
 await closing.refresh(second);
 const unlock = lock(source.cacheDir), order: string[] = [];
 let started!: () => void;
 const running = new Promise<void>((resolve) => { started = resolve; });
 const derived = closing.refresh(source, started).then((data) => { order.push("derive"); return data; });
 await running;
 const queued = assert.rejects(closing.refresh(second), /Working set stopped/);
 await new Promise((resolve) => setImmediate(resolve));
 const closed = Promise.resolve(closing.close()).then(() => { order.push("close"); });
 setTimeout(unlock, 300);
 await closed;
 assert.deepEqual(order, ["derive", "close"]);
 assert.ok((await derived)?.version);
 await queued;
 assert.deepEqual(files(source.cacheDir, /-(wal|shm)$/), []);
});

test("working set: a close that outlives its deadline logs once and the shared Worker takes no later write for the cache", async (t) => {
 const { source: owner, store } = setup(t, [msg("e1", null, "prose")]);
 await store.ready;
 const { CLOSE_MS, SLOW_CLOSE_MS } = WorkingSet;
 WorkingSet.CLOSE_MS = 200; WorkingSet.SLOW_CLOSE_MS = 100;
 t.after(() => { WorkingSet.CLOSE_MS = CLOSE_MS; WorkingSet.SLOW_CLOSE_MS = SLOW_CLOSE_MS; });
 const errors = t.mock.method(console, "error", () => {});
 const source = cache(t, "slow");
 const closing = new WorkingSet(source.host, source.cacheDir);
 await closing.refresh({ ...source, path: "/synthetic/warm.jsonl" });
 const unlock = lock(source.cacheDir);
 let started!: () => void;
 const running = new Promise<void>((resolve) => { started = resolve; });
 const derived = closing.refresh(source, started).catch(() => null);
 await running;
 const begun = performance.now();
 await closing.close();
 assert.ok(performance.now() - begun < 2000, "close waits for the deadline, not for the job");
 assert.equal(errors.mock.callCount(), 1);
 assert.match(String(errors.mock.calls[0]!.arguments[0]), /^working set: close waited \d+ ms for .+, derive job, stopped waiting$/);
 rmSync(source.cacheDir, { recursive: true });
 unlock(); await derived;
 assert.ok(await store.refresh(owner));
 assert.equal(existsSync(source.cacheDir), false, "the Worker wrote the closed cache after close resolved");
 assert.equal(errors.mock.callCount(), 1);
});

test("working set: a new store on a closed cache reopens it in the shared Worker", async (t) => {
 const { store } = setup(t, []);
 await store.ready;
 const source = cache(t, "reopened");
 await new WorkingSet(source.host, source.cacheDir).close();
 const reopened = new WorkingSet(source.host, source.cacheDir);
 t.after(() => reopened.close());
 await reopened.ready;
 assert.ok((await reopened.refresh(source))?.version);
});
