import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSocketRoute } from "playwright";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
const { routeFixture } = await import(new URL("../scripts/ux/fixtures.mjs", import.meta.url).href);
const { thread } = await import(new URL("../scripts/ux/recipes.mjs", import.meta.url).href);

for (const [engine, type, path] of ENGINES) {
	for (const reason of ["view is not available for Pi Sessions yet", "Unsupported topic: arc", "Synthetic reader failure. Reconnect to retry."]) {
		test(`Arc topic end ${engine}: ${reason}`, { skip: engineSkip(engine) }, async (t) => {
			const page = await open(t, engine, type, path(), { route: thread("lead"), context: { viewport: { width: 320, height: 800 } } });
			const arcSids = new Set<number>();
			await routeFixture(page, {}, { requests: [] }, { through(ws: WebSocketRoute) {
				return {
					connectToServer: () => ws.connectToServer(),
					onMessage(fn: (raw: string | Buffer) => void) { ws.onMessage((raw) => { const frame = JSON.parse(String(raw)); if (frame.t === "sub" && frame.topic?.view === "arc") arcSids.add(frame.sid); fn(raw); }); },
					send(raw: string | Buffer) { const frame = JSON.parse(String(raw)); ws.send(frame.t === "snap" && arcSids.has(frame.sid) ? JSON.stringify({ t: "end", sid: frame.sid, reason }) : raw); },
				};
			} });
			await page.goto(new URL(thread("lead", "arc"), page.url()).href);
			await page.reload();
			const panel = page.locator(".arc-panel");
			await panel.locator('[role="alert"], [role="status"]').first().waitFor();
			if (reason.startsWith("Synthetic")) {
				await panel.getByRole("alert").waitFor();
				assert.match(await panel.innerText(), /Retry Build/);
				assert.equal(await panel.getByRole("button", { name: "Build", exact: true }).isEnabled(), true, "ordinary failures keep their retry");
			} else {
				const message = "Arc isn't available on this Host. Update its AmPi hub to use Arc.";
				const status = panel.getByText(message, { exact: true });
				assert.equal(await status.count(), 1, await panel.innerText());
				const build = panel.getByRole("button", { name: "Build", exact: true });
				assert.equal(await build.isDisabled(), true);
				assert.equal(await build.getAttribute("title"), message);
				assert.ok(await status.getAttribute("id"));
				assert.equal(await build.getAttribute("aria-describedby"), await status.getAttribute("id"));
				assert.equal(await panel.getByLabel("Arc Build options", { exact: true }).count(), 0);
				assert.equal(await panel.getByRole("button", { name: "Rebuild", exact: true, includeHidden: true }).count(), 0);
				assert.equal(await panel.getByRole("status").count(), 1, "unsupported has one state message");
				assert.equal(await panel.getByRole("alert").count(), 0);
				assert.doesNotMatch(await panel.innerText(), /Reading the saved Arc|Retry Build|Build request failed/);
			}
		});
	}
}
