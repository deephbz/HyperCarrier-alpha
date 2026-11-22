import "./bound.ts";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import WebSocket from "ws";
import { stamp } from "../src/shared/build.ts";
import { fixtureSessions, ENGINES, open, releaseFixtureProseIndex, waitForFixtureProseIndexHeld, waitForProgress } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

const QUERY = "Synthetic Session 999";
type Coverage = { indexed: number; notIndexed: number; updating?: number; hits: { threadId: string }[] };
type PaletteState = { requests: number; input: string; empty: string; text: string; hits: number };
const SEARCH_WAIT = { budgetMs: 30_000, maxMs: 160_000 } as const;

async function searchCount(page: import("playwright").Page) {
	return page.evaluate(() => (window as Window & { __proseSearchRequests?: string[] }).__proseSearchRequests?.length ?? 0);
}
async function paletteState(page: import("playwright").Page): Promise<PaletteState> {
	return page.evaluate(() => {
		const modal = document.querySelector(".modal");
		return {
			requests: (window as Window & { __proseSearchRequests?: string[] }).__proseSearchRequests?.length ?? 0,
			input: modal?.querySelector<HTMLInputElement>('input[aria-label="Find a Session"]')?.value ?? "",
			empty: modal?.querySelector(".empty")?.textContent ?? "",
			text: modal?.textContent ?? "",
			hits: modal?.querySelectorAll(".prose-hit").length ?? 0,
		};
	});
}
async function coverage(page: import("playwright").Page): Promise<Coverage> {
	const url = new URL(page.url());
	const socket = new WebSocket(`ws://${url.host}/ws`, { headers: { authorization: `Bearer ${url.searchParams.get("k")}` } });
	return new Promise((resolve, reject) => {
		socket.on("open", () => {
			socket.send(JSON.stringify({ t: "hello", build: stamp().id }));
			socket.send(JSON.stringify({ t: "req", id: 1, host: "devbox", op: "sessions.search", args: { query: QUERY } }));
		});
		socket.on("message", (data) => {
			const frame = JSON.parse(String(data));
			if (frame.t !== "res" || frame.id !== 1) return;
			socket.close();
			if (!frame.ok) reject(new Error(frame.error?.message ?? "Hub prose search failed"));
			else resolve({ ...frame.value.coverage, hits: frame.value.hits });
		});
		socket.on("error", reject);
	});
}
async function waitForSearchAnswer(page: import("playwright").Page, after: number) {
	return waitForProgress(() => paletteState(page), (state) => `${state?.requests ?? 0}:${state?.input ?? ""}:${state?.empty ?? ""}:${state?.hits ?? 0}`, (state): state is PaletteState => Boolean(state && state.requests > after && state.input === QUERY && (state.hits > 0 || (state.empty !== "" && state.empty !== "Searching…" && state.empty !== "Type words to search prose."))), SEARCH_WAIT);
}
async function consistentSnapshot(page: import("playwright").Page) {
	return waitForProgress(async () => {
		const [palette, state] = await Promise.all([paletteState(page), coverage(page)]);
		const pending = state.notIndexed + (state.updating ?? 0);
		const label = palette.text.match(/Still reading ([\d,]+) Sessions?/);
		const displayed = label ? Number(label[1].replaceAll(",", "")) : 0;
		return { state, pending, displayed, text: palette.text };
	}, (snapshot) => `${snapshot?.pending ?? "?"}:${snapshot?.displayed ?? "?"}`, (snapshot): snapshot is { state: Coverage; pending: number; displayed: number; text: string } => Boolean(snapshot && snapshot.displayed === snapshot.pending), SEARCH_WAIT);
}

for (const [engine, type, path] of ENGINES) {
	test(`prose palette ${engine}: one thousand cold Sessions reach their unique hit`, { skip: engineSkip(engine), timeout: 170_000 }, async (t) => {
		// Keep one 1,000-Session backlog proof in exhaustive-only; the fast test uses two appended cold Sessions.
		const fixtureKey = `prose-pending-exhaustive-${engine}`;
		const page = await open(t, engine, type, path(), { fixture: "huge", fixtureKey, holdProseIndex: true, waitForEntry: false, earlyStart: true, recordSearch: true, seedArcs: false });
		t.after(() => releaseFixtureProseIndex("huge", fixtureKey, false, false));
		const files = readdirSync(await fixtureSessions("huge", fixtureKey, false), { recursive: true }).map(String).filter((name) => /(?:^|\/)stress-\d+\.jsonl$/.test(name));
		assert.equal(files.length, 1000, "the exhaustive fixture contains 1,000 stress Sessions");
		await waitForFixtureProseIndexHeld("huge", fixtureKey, false, false);
		const beforeSearch = await searchCount(page);
		await page.getByRole("button", { name: /Search Sessions or prose/ }).click();
		await page.getByRole("button", { name: "Prose", exact: true }).click();
		await page.getByRole("textbox", { name: "Find a Session" }).fill(QUERY);
		const list = page.locator(".modal");
		await waitForSearchAnswer(page, beforeSearch);
		const held = await consistentSnapshot(page);
		assert.ok(held.pending >= 1000, `the cold index holds at least the 1,000 stress Sessions (${held.pending})`);
		assert.equal(held.state.hits.length, 0, "the unique stress-999 term is absent while held");
		assert.match(await list.locator(".empty").innerText(), /^No prose matches yet\. Still reading [\d,]+ Sessions?\.$/);
		const searchesBeforeRelease = await searchCount(page);
		const routeBeforeRelease = page.url();
		await releaseFixtureProseIndex("huge", fixtureKey, false, false);
		const final = await waitForProgress(
			() => consistentSnapshot(page),
			(value) => `${value?.pending ?? "?"}:${value?.state.hits.length ?? 0}`,
			(value): value is typeof held => Boolean(value && value.pending === 0 && value.state.hits.some((hit) => hit.threadId.includes("stress-999")) && !/Still reading /.test(value.text)),
			{ budgetMs: 30_000, maxMs: 160_000 },
		);
		assert.ok(final.state.hits.some((hit) => hit.threadId.includes("stress-999")), "the held Session becomes a prose-search hit");
		await waitForProgress(() => list.locator(".prose-hit").count(), (count) => String(count ?? 0), (count): count is number => count !== undefined && count > 0, { budgetMs: 15_000, maxMs: 30_000 });
		await list.getByText(/Still reading .*; results may grow\./).waitFor({ state: "detached", timeout: 12_000 });
		assert.ok(await list.locator(".prose-hit").count() > 0);
		assert.equal(await list.getByText(/Still reading .*; results may grow\./).count(), 0, "the pending footer disappears after the backlog drains");
		assert.equal((await paletteState(page)).input, QUERY, "index completion keeps the current query without a new user search");
		assert.ok(await searchCount(page) >= searchesBeforeRelease, "the same pending query may poll while the index drains");
		assert.equal(page.url(), routeBeforeRelease, "index completion does not navigate");
	});
}
