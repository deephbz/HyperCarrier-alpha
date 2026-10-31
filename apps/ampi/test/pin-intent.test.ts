import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

// Pin membership has one writer: the owner's click on the star, the row menu or the ×. Each click sends the state the
// control offered, and the hub applies it idempotently. A window's host-hint repair sends pins.hint, which moves the
// host of a pin that still exists and never creates one. Three windows on the demo hub; a WebSocket gate per window
// holds its pin traffic to make it late or stale.
const LEAD = "pi:sess-lead";
// Each browser engine exercises the same multi-window protocol.

async function eventually(check: () => Promise<boolean>, what: string) {
	for (const end = Date.now() + 10_000; Date.now() < end;) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
	assert.fail(what);
}

/** One hub op on a fresh socket of this page; returns the hub's pins list after the op. */
const hubOp = (page: Page, op: string, args: object) => page.evaluate(([op, args]) => new Promise<{ ok: boolean; pins: { host: string; threadId: string }[] }>((done, fail) => {
	const ws = new WebSocket(`ws://${location.host}/ws`);
	let pins: any;
	ws.onopen = () => ws.send(JSON.stringify({ t: "hub", id: 1, op, args }));
	ws.onmessage = (e) => { const f = JSON.parse(e.data); if (f.t === "pins") pins = f.pins; if (f.t === "res") { ws.close(); done({ ok: f.ok, pins }); } };
	ws.onerror = () => fail(new Error("hub socket failed"));
}), [op, args] as const);
// An unpin needs no host; the host here lets the same test run on an older hub for a red check.
const pinsNow = async (page: Page) => (await hubOp(page, "pins.set", { host: "verify", threadId: "verify:none", pinned: false })).pins;
const unpin = (page: Page) => hubOp(page, "pins.set", { host: "verify", threadId: LEAD, pinned: false });

/** Proxies the page's hub socket. `out` holds the page's pins ops; `in` holds the hub's pins frames to the page. */
async function gate(page: Page) {
	const g = { out: false, in: false, heldOut: [] as (() => void)[], heldIn: [] as (() => void)[], waiting: new Set<number>() };
	await page.routeWebSocket("**/ws", (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const f = JSON.parse(String(raw));
			if (g.out && f.t === "hub" && String(f.op).startsWith("pins.")) g.heldOut.push(() => { g.waiting.add(f.id); server.send(raw); });
			else server.send(raw);
		});
		server.onMessage((raw) => {
			const f = JSON.parse(String(raw));
			if (f.t === "res") g.waiting.delete(f.id);
			if (g.in && f.t === "pins") g.heldIn.push(() => ws.send(raw));
			else ws.send(raw);
		});
	});
	await page.reload();
	await page.locator(".transcript [data-entry]").first().waitFor({ state: "attached" });
	return {
		g,
		/** Sends what the gate holds; resolves when the hub has answered each released op. */
		async release() {
			g.out = g.in = false;
			for (const send of g.heldOut.splice(0)) send();
			for (const send of g.heldIn.splice(0)) send();
			await eventually(async () => g.waiting.size === 0, "the hub did not answer the released pin ops");
		},
	};
}
const star = (page: Page) => page.locator(".pin-star");
const pressed = (page: Page, value: "true" | "false", what: string) => eventually(async () => (await star(page).getAttribute("aria-pressed")) === value, what);

for (const [engine, type, path] of ENGINES) {
test(`pin intent ${engine}: a late hint after an unpin does not pin the Session again in any window`, { skip: engineSkip(engine) }, async (t) => {
	const [a, b, c] = [await open(t, engine, type, path()), await open(t, engine, type, path()), await open(t, engine, type, path())];
	try {
		const late = [await gate(b), await gate(c)];
		await unpin(a);
		for (const { g } of late) g.out = true;
		// A pin under a Host id that no longer lists the Session: every window repairs the hint.
		assert.equal((await hubOp(a, "pins.set", { host: "verify-old-host", threadId: LEAD, pinned: true, intent: "owner" })).ok, true);
		await eventually(async () => late.every(({ g }) => g.heldOut.length > 0), "windows B and C did not send their hint repair");
		await eventually(async () => (await pinsNow(a)).some((p) => p.threadId === LEAD && p.host !== "verify-old-host"), "window A did not repair the hint");
		// The owner unpins in A; then the hints of B and C arrive.
		await pressed(a, "true", "window A does not show the pin");
		await star(a).click();
		await eventually(async () => !(await pinsNow(a)).some((p) => p.threadId === LEAD), "the star did not unpin");
		for (const each of late) await each.release();
		assert.deepEqual((await pinsNow(a)).filter((p) => p.threadId === LEAD), [], "a late hint pinned the Session again");
		for (const page of [a, b, c]) {
			await page.reload();
			await star(page).waitFor();
			await page.waitForTimeout(300);
			assert.equal(await star(page).getAttribute("aria-pressed"), "false", "a window shows the Session as pinned after reload");
			assert.equal(await page.locator(`[data-pinned] .pin-row[data-pin="${LEAD}"]`).count(), 0, "a window lists the pin after reload");
		}
	} finally { await unpin(a); }
});

test(`pin intent ${engine}: a stale window's star sends the state it shows, and that intent wins`, { skip: engineSkip(engine) }, async (t) => {
	const [a, b] = [await open(t, engine, type, path()), await open(t, engine, type, path())];
	try {
		const stale = await gate(b);
		await unpin(a);
		await pressed(b, "false", "window B shows a pin before the test");
		// A pins; B does not get the change and still offers "Pin". The owner clicks Pin in B.
		stale.g.in = true;
		await star(a).click();
		await pressed(a, "true", "the star in A did not pin");
		assert.equal(await star(b).getAttribute("aria-label"), "Pin this Session");
		await star(b).click();
		await stale.release();
		await pressed(b, "true", "the stale Pin click in B unpinned the Session");
		assert.ok((await pinsNow(a)).some((p) => p.threadId === LEAD), "the hub lost the pin");
		await pressed(a, "true", "window A lost the pin");
		// A unpins; B still offers "Unpin". The owner clicks Unpin in B.
		stale.g.in = true;
		await star(a).click();
		await pressed(a, "false", "the star in A did not unpin");
		assert.equal(await star(b).getAttribute("aria-label"), "Unpin this Session");
		await star(b).click();
		await stale.release();
		await pressed(b, "false", "the stale Unpin click in B pinned the Session");
		assert.ok(!(await pinsNow(a)).some((p) => p.threadId === LEAD), "the hub kept the pin");
		await pressed(a, "false", "window A shows the pin again");
	} finally { await unpin(a); }
});

test(`pin intent ${engine}: an old page cannot recreate a new page's removed pin`, { skip: engineSkip(engine) }, async (t) => {
	const a = await open(t, engine, type, path()), old = await open(t, engine, type, path());
	try {
		await unpin(a);
		await pressed(a, "false", "new page starts unpinned");
		await star(a).click();
		await pressed(old, "true", "old page sees the new pin");
		assert.equal((await hubOp(old, "pins.set", { host: "old-route", threadId: LEAD, pinned: true })).ok, true);
		assert.equal((await hubOp(old, "pins.set", { host: "old-route", threadId: LEAD, pinned: false })).ok, true);
		await pressed(a, "false", "old page can unpin");
		assert.equal((await hubOp(old, "pins.set", { host: "old-route", threadId: LEAD, pinned: true })).ok, false, "old repair cannot create");
		assert.equal((await hubOp(old, "pins.hint", { host: "old-route", threadId: LEAD })).ok, true);
		assert.ok(!(await pinsNow(a)).some(p => p.threadId === LEAD));
		await a.reload();
		await pressed(a, "false", "reload keeps the old page's unpin");
		await star(a).click();
		await pressed(old, "true", "a current owner action still creates");
	} finally { await unpin(a); }
});
}
