import "./bound.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { skewText, VERSION_SKEW } from "../src/shared/build.ts";
import { Browser } from "./helpers.ts";
import { control } from "./pi-fixtures.ts";
import { setup, TOKEN } from "./pi-host-fixtures.ts";

// P1: one build everywhere. The hub serves a page its own build, and the page says that build in its first frame. A
// page of another build, or one that never said its build, still reads; every action it sends is refused with
// VERSION_SKEW and the page text before it reaches a pin, a Host or Pi.

const skewed = (e: any) => e.code === VERSION_SKEW && e.message === skewText.page;

test("version skew: a page of another build reads, and the hub refuses its pin and its message with the page text", async (t) => {
	const { f, hub, browser, port } = await setup(t);
	const ctl = await control(f, f.sessionA);
	t.after(() => ctl.close());
	const cookie = `ampi_k_${port}=${TOKEN}`;
	const old = await Browser.open(port, undefined, cookie, "0ld0ld0ld0ld");
	const unsaid = await Browser.open(port, undefined, cookie, null);
	t.after(() => { old.ws.close(); unsaid.ws.close(); });
	const herdr = f.herdrCalls().length;

	for (const page of [old, unsaid]) {
		// Reads: a subscription and a read op.
		const threads = page.sub("devbox", { kind: "threads" });
		await page.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true);
		const history = await page.req("devbox", "thread.history", { threadId: "pi:sess-a" });
		assert.ok(Array.isArray(history.entries), "a read still returns");
		// Actions: a hub op and a Host write.
		await assert.rejects(page.hub("pins.set", { host: "devbox", threadId: "pi:sess-a", pinned: true }), skewed);
		await assert.rejects(page.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "hello" }), skewed);
	}
	assert.deepEqual(hub.pins.list(), [], "no pin was made");
	assert.equal(ctl.requests.filter((r) => r.op === "submit").length, 0, "no message reached the control");
	assert.equal(f.herdrCalls().length, herdr, "no message reached Herdr");

	// The page of the hub's build acts.
	await browser.hub("pins.set", { host: "devbox", threadId: "pi:sess-a", pinned: true });
	assert.deepEqual(hub.pins.list().map((p) => p.threadId), ["pi:sess-a"]);
});

test("version skew: the hub writes its build into the page it serves and into every hosts frame", async (t) => {
	const { hub, browser, port } = await setup(t);
	await browser.when(() => browser.build !== undefined, 5000, "the hosts frame");
	assert.equal(browser.build, hub.stamp.id);
	if (existsSync(join(import.meta.dirname, "..", "web", "dist", "index.html"))) {
		const html = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: `ampi_k_${port}=${TOKEN}` } })).text();
		assert.match(html, new RegExp(`<meta name="ampi-build" content="${hub.stamp.id}" />\\s*</head>`));
	}
});
