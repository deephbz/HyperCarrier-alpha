import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { entries, open, view, type Answer } from "./thread-scroll-fixture.ts";

// A history read pinned to the view's source version (protocol.ts STALE_VERSION) can race a live update (a compaction,
// a new entry): the node refuses it as `stale_version`. The read waits for the view's newer version and reads again;
// after STALE_READS reads the view refreshes itself once and one read follows. Only `not_found` says the entry is
// missing (failure: durable-round2 reader-compact-citation, "could not be loaded from this copied branch").

const TARGET = "e20";
type Reply = Parameters<Answer>[1];
const around = (version: string) => ({ ok: true as const, value: { entries: entries(41), more: true, version } });
const refuse = (code: string, message: string) => ({ ok: false as const, error: { code, message } });
const STALE = refuse("stale_version", "History changed; refresh this Session");
/** A reader Session whose view starts at e100, at source version `version`. */
const at = (version: string) => ({ ...view(300, "", 100), sourceVersion: version });

/** Opens the reader Session at v1 and answers its history and entry reads with `respond`. */
async function session(t: Parameters<typeof open>[0], respond: (op: string, args: Record<string, unknown>, reply: Reply, fixture: Awaited<ReturnType<typeof open>>) => boolean) {
	const fixture = await open(t, 300, "pi");
	fixture.send(at("v1"));
	await fixture.page.locator('[data-entry="e299"]').waitFor({ state: "attached" });
	const reads: string[] = [];
	fixture.answer((frame, reply) => {
		if (frame.op !== "thread.history" && frame.op !== "thread.entry") return false;
		reads.push(`${frame.args.around ?? frame.args.before ?? `${frame.args.entry}@${frame.args.offset}`}:${frame.args.version ?? "-"}`);
		return respond(frame.op, frame.args, reply, fixture);
	});
	return { ...fixture, reads };
}
/** Opens the citation `?e=e20`, whose `around` read `respond` answers. */
async function jump(t: Parameters<typeof open>[0], respond: (version: string, reply: Reply, fixture: Awaited<ReturnType<typeof open>>) => void) {
	const s = await session(t, (op, args, reply, fixture) => {
		if (op !== "thread.history" || args.around !== TARGET) return false;
		respond(String(args.version), reply, fixture);
		return true;
	});
	await s.page.evaluate((entry) => { (window as any).ENTRY = entry; (window as any).parentTicks = true; }, TARGET);
	return s;
}
const missing = (page: Awaited<ReturnType<typeof open>>["page"]) => page.locator(".entry-missing:not([data-history-cue])").count();

test("history version: a read refused as stale shows a quiet cue, then reads again once the view shows the newer version", async (t) => {
	const { page, reads } = await jump(t, (version, reply, { send }) => {
		// The node has moved to v2; the view learns it only after the refusal, as in the recorded failure.
		if (version === "v1") { reply(STALE); setTimeout(() => send(at("v2")), 900); }
		else reply(around(version));
	});
	await page.locator("[data-history-cue]", { hasText: "Loading entry…" }).waitFor();
	await page.locator(`[data-entry="${TARGET}"]`).waitFor({ state: "attached" });
	assert.deepEqual(reads, ["e20:v1", "e20:v2"], "one stale read, then one read at the newer version");
	assert.equal(await page.locator("[data-history-cue]").count(), 0, "the cue leaves with the read");
	assert.equal(await missing(page), 0, "a valid citation never says it could not be loaded");
});

test("history version: a newer version that only a fresh view shows: the view refreshes itself once, then the read succeeds", async (t) => {
	const { page, reads, subs } = await jump(t, (version, reply, { hold }) => {
		// The node moved to v2 but its live update never reached the page.
		hold(at("v2"));
		reply(version === "v2" ? around(version) : STALE);
	});
	await page.locator(`[data-entry="${TARGET}"]`).waitFor({ state: "attached", timeout: 10_000 });
	assert.deepEqual(reads, ["e20:v1", "e20:v1", "e20:v1", "e20:v2"], "three stale reads, one refresh, one read at its version");
	assert.equal(subs(), 2, "one fresh subscription");
	assert.equal(await page.locator(".err-box").count(), 0);
});

test("history version: a version that never arrives stops after the refresh read; the box says what happened and dismisses", async (t) => {
	const { page, reads, subs } = await jump(t, (_version, reply) => reply(STALE));
	const box = page.locator(".err-box", { hasText: "kept changing" });
	await box.waitFor({ timeout: 10_000 });
	assert.equal(reads.length, 4, `bounded reads: ${reads.join(", ")}`);
	assert.equal(subs(), 2, "the view refreshed once");
	assert.match(await box.innerText(), /^This Session kept changing while AmPi read its history, even after a fresh copy of the view\. Wait for the run to settle, then retry\./);
	assert.equal(await missing(page), 0, "a stale Session is not a missing entry");
	await box.getByRole("button", { name: "Dismiss" }).click();
	assert.equal(await page.locator(".err-box").count(), 0);
});

test("history version: an old node's generic stale reply says the node may need the new build", async (t) => {
	const { page, reads } = await jump(t, (_version, reply) => reply(refuse("error", "History changed; refresh this Session")));
	const box = page.locator(".err-box", { hasText: "may need the new build" });
	await box.waitFor();
	assert.deepEqual(reads, ["e20:v1"], "a generic code is not retried");
	const text = await box.innerText();
	assert.doesNotMatch(text, /Error:|\(|History changed/, "owner words; the node's raw reply stays out of the text");
	assert.equal(await box.locator("[title]").getAttribute("title"), "History changed; refresh this Session", "the raw reply is one hover away");
	assert.equal(await missing(page), 0);
});

test("history version: Retry on a failed citation jump reads again with fresh bounds and clears the box on success", async (t) => {
	let settled = false;
	const { page, reads, subs } = await jump(t, (version, reply) => reply(settled ? around(version) : STALE));
	const box = page.locator(".err-box", { hasText: "kept changing" });
	await box.waitFor({ timeout: 10_000 });
	assert.equal(reads.length, 4);
	settled = true;
	await box.getByRole("button", { name: "Retry" }).click();
	await page.locator(`[data-entry="${TARGET}"]`).waitFor({ state: "attached" });
	assert.equal(reads.length, 5, `one more read: ${reads.join(", ")}`);
	assert.equal(await page.locator(".err-box").count(), 0, "success clears the box");
	assert.equal(await missing(page), 0);
	assert.equal(subs(), 2, "the retry needed no refresh");
});

test("history version: Retry on a failed earlier page reads that page again", async (t) => {
	let settled = false;
	const { page, reads } = await session(t, (op, args, reply) => {
		if (op !== "thread.history" || args.before !== "e100") return false;
		if (!settled) reply(refuse("error", "disk read failed"));
		else reply({ ok: true, value: { entries: entries(100).slice(60), more: true, version: String(args.version) } });
		return true;
	});
	await page.getByRole("button", { name: "Read an earlier page" }).click();
	const box = page.locator(".err-box", { hasText: "disk read failed" });
	await box.waitFor();
	settled = true;
	await box.getByRole("button", { name: "Retry" }).click();
	await page.locator('[data-entry="e80"]').waitFor({ state: "attached" });
	assert.deepEqual(reads, ["e100:v1", "e100:v1"]);
	assert.equal(await page.locator(".err-box").count(), 0);
});

test("history version: only an entry the branch does not hold is missing", async (t) => {
	const { page, reads } = await jump(t, (_version, reply) => reply(refuse("not_found", "Entry is not on the current branch")));
	await page.locator(".entry-missing").waitFor();
	assert.deepEqual(reads, ["e20:v1"], "not_found is final");
});

test("history version: an earlier page refused as stale reads again at the newer version", async (t) => {
	const { page, reads } = await session(t, (op, args, reply, { send }) => {
		if (op !== "thread.history" || args.before !== "e100") return false;
		if (args.version === "v1") { reply(STALE); setTimeout(() => send(at("v2")), 100); }
		else reply({ ok: true, value: { entries: entries(100).slice(60), more: true, version: String(args.version) } });
		return true;
	});
	await page.getByRole("button", { name: "Read an earlier page" }).click();
	await page.locator('[data-entry="e80"]').waitFor({ state: "attached" });
	assert.deepEqual(reads, ["e100:v1", "e100:v2"]);
	assert.equal(await page.locator(".err-box").count(), 0);
});

test("history version: an entry that goes stale after its first page restarts at offset 0 and keeps no old bytes", async (t) => {
	const oldBody = JSON.stringify({ id: "e298", kind: "user", text: `OLD ${"o".repeat(200)}`, images: 0 });
	const newBody = JSON.stringify({ id: "e298", kind: "user", text: `NEW ${"n".repeat(200)}`, images: 0 });
	let version = "v1";
	const { page, reads, send } = await session(t, (op, args, reply) => {
		if (op !== "thread.entry") return false;
		const offset = Number(args.offset ?? 0);
		if (args.version && args.version !== version) { reply(refuse("stale_version", "Entry changed; refresh this Session")); return true; }
		const body = version === "v1" ? oldBody : newBody, end = offset === 0 ? 100 : body.length;
		reply({ ok: true, value: { text: body.slice(offset, end), next: end, more: end < body.length, version } });
		// The Session moves on after the first page.
		version = "v2";
		return true;
	});
	const v = at("v1");
	v.entries = v.entries.map((e: any) => e.id === "e298" ? { id: "e298", kind: "user", text: "preview", images: 0, bodyAvailable: true } : e);
	send(v);
	await page.getByRole("button", { name: "Show full message" }).click();
	const full = page.locator('[data-entry="e298"]', { hasText: "NEW nnn" });
	await full.waitFor();
	assert.deepEqual(reads, ["e298@0:-", "e298@100:v1", "e298@0:-", "e298@100:v2"], "page 2 refused; the read restarts unpinned at offset 0");
	assert.doesNotMatch(await full.innerText(), /OLD|ooo/, "no bytes of the old version");
});
