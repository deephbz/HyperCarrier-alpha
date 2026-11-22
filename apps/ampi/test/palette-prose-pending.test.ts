import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { stamp } from "../src/shared/build.ts";
import { fixtureSessions, installFixtureProseIndexHold, ENGINES, open, releaseFixtureProseIndex, waitForFixtureProseIndexHeld, waitForProgress } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

const HELD_QUERY = "Held cold violet";
const WARM_QUERY = "One synthetic message";
const HELD_SESSIONS = 2;

type Coverage = { indexed: number; notIndexed: number; updating?: number; hits: { threadId: string }[] };
async function searchCount(page: import("playwright").Page) {
	return page.evaluate(() => (window as Window & { __proseSearchRequests?: string[] }).__proseSearchRequests?.length ?? 0);
}

type PaletteState = { requests: number; input: string; empty: string; text: string; hits: number };
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

const SEARCH_WAIT = { budgetMs: 30_000, maxMs: 160_000 } as const;
async function waitForSearchAnswer(page: import("playwright").Page, query: string, after: number) {
	return waitForProgress(() => paletteState(page), (state) => `${state?.requests ?? 0}:${state?.input ?? ""}:${state?.empty ?? ""}:${state?.hits ?? 0}`, (state): state is PaletteState => Boolean(state && state.requests > after && state.input === query && (state.hits > 0 || (state.empty !== "" && state.empty !== "Searching…" && state.empty !== "Type words to search prose."))), SEARCH_WAIT);
}

async function coverage(page: import("playwright").Page, query: string): Promise<Coverage> {
	const url = new URL(page.url());
	const socket = new WebSocket(`ws://${url.host}/ws`, { headers: { authorization: `Bearer ${url.searchParams.get("k")}` } });
	return new Promise((resolve, reject) => {
		socket.on("open", () => {
			socket.send(JSON.stringify({ t: "hello", build: stamp().id }));
			socket.send(JSON.stringify({ t: "req", id: 1, host: "devbox", op: "sessions.search", args: { query } }));
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

async function consistentSnapshot(page: import("playwright").Page, query: string) {
	return waitForProgress(async () => {
		const [palette, state] = await Promise.all([paletteState(page), coverage(page, query)]);
		const pending = state.notIndexed + (state.updating ?? 0);
		const label = palette.text.match(/Still reading ([\d,]+) Sessions?/);
		const displayed = label ? Number(label[1].replaceAll(",", "")) : 0;
		return { state, pending, displayed, text: palette.text };
	}, (snapshot) => `${snapshot?.pending ?? "?"}:${snapshot?.displayed ?? "?"}`, (snapshot): snapshot is { state: Coverage; pending: number; displayed: number; text: string } => Boolean(snapshot && snapshot.displayed === snapshot.pending), { budgetMs: 30_000, maxMs: 160_000 });
}

for (const [engine, type, path] of ENGINES) {
	test(`prose palette ${engine}: two held Sessions stay provisional, then a warm hit settles`, { skip: engineSkip(engine), timeout: 170_000 }, async (t) => {
		const fixtureKey = `prose-pending-${engine}`;
		const page = await open(t, engine, type, path(), { fixture: "one", fixtureKey, holdProseIndexAfterStart: true, waitForEntry: false, earlyStart: true, recordSearch: true, seedArcs: false });
		t.after(() => releaseFixtureProseIndex("one", fixtureKey, true, false));
		const warm = await waitForProgress(() => coverage(page, WARM_QUERY), (state) => `${state?.notIndexed ?? "?"}:${state?.hits.length ?? 0}`, (state): state is Coverage => Boolean(state && state.notIndexed + (state.updating ?? 0) === 0 && state.hits.length > 0), { budgetMs: 30_000, maxMs: 60_000 });
		assert.ok(warm.hits.length > 0, "the single warm Session is indexed before the hold starts");
		await installFixtureProseIndexHold("one", fixtureKey, false);
		const root = await fixtureSessions("one", fixtureKey, false, undefined, true);
		const heldDir = join(root, "--work-held-palette--");
		mkdirSync(heldDir, { recursive: true });
		const timestamp = new Date().toISOString();
		for (const id of ["palette-held-a", "palette-held-b"]) {
			const entries = [
				{ type: "session", version: 3, id, timestamp, cwd: "/work/synthetic/held" },
				{ type: "message", id: `${id}-entry`, parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: `${HELD_QUERY} appears only in this held cold Session.` }] } },
			];
			writeFileSync(join(heldDir, `${id}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		}
		await waitForFixtureProseIndexHeld("one", fixtureKey, true, false);
		const list = page.locator(".modal");
		const openPalette = () => page.getByRole("button", { name: /Search Sessions or prose/ }).click();
		await openPalette();
		await page.getByRole("button", { name: "Prose", exact: true }).click();
		let beforeSearch = await searchCount(page);
		const input = page.getByRole("textbox", { name: "Find a Session" });
		await input.fill(HELD_QUERY);
		await waitForSearchAnswer(page, HELD_QUERY, beforeSearch);
		let snapshot = await consistentSnapshot(page, HELD_QUERY);
		assert.equal(snapshot.pending, HELD_SESSIONS, "pending equals the two held cold Sessions");
		assert.equal(snapshot.state.hits.length, 0, "the held-only term has no indexed matches");
		assert.equal(await list.locator(".empty").innerText(), "No prose matches yet. Still reading 2 Sessions.");
		assert.doesNotMatch(snapshot.text, /No prose matches\.(?! yet)/, "the palette does not show a final miss while held Sessions remain");

		const searchesBeforeClose = await searchCount(page);
		await page.keyboard.press("Escape");
		await page.getByRole("dialog", { name: "Search Sessions or prose" }).waitFor({ state: "detached" });
		await new Promise((resolve) => setTimeout(resolve, 5_500));
		assert.equal(await searchCount(page), searchesBeforeClose, "a closed palette does not issue another prose search");

		await openPalette();
		const searchesBeforeReopen = await searchCount(page);
		await page.getByRole("textbox", { name: "Find a Session" }).fill(HELD_QUERY);
		await waitForSearchAnswer(page, HELD_QUERY, searchesBeforeReopen);
		snapshot = await consistentSnapshot(page, HELD_QUERY);
		assert.equal(snapshot.pending, HELD_SESSIONS, "reopening while held preserves the exact pending count");
		assert.equal(snapshot.state.hits.length, 0);
		assert.equal(await list.locator(".empty").innerText(), "No prose matches yet. Still reading 2 Sessions.");

		beforeSearch = await searchCount(page);
		await page.getByRole("textbox", { name: "Find a Session" }).fill(WARM_QUERY);
		await waitForSearchAnswer(page, WARM_QUERY, beforeSearch);
		snapshot = await consistentSnapshot(page, WARM_QUERY);
		assert.equal(snapshot.pending, HELD_SESSIONS);
		assert.ok(snapshot.state.hits.length > 0 && await list.locator(".prose-hit").count() > 0, "an indexed warm hit appears while two Sessions remain pending");
		assert.match(snapshot.text, /Still reading 2 Sessions?; results may grow\./, "pending results show the provisional footer");
		const searchesBeforeRelease = await searchCount(page);
		const routeBeforeRelease = page.url();
		await releaseFixtureProseIndex("one", fixtureKey, true, false);
		const final = await waitForProgress(
			() => consistentSnapshot(page, WARM_QUERY),
			(value) => `${value?.pending ?? "?"}:${value?.state.hits.length ?? 0}`,
			(value): value is typeof snapshot => Boolean(value && value.pending === 0 && value.state.hits.length > 0 && !/Still reading /.test(value.text)),
			{ budgetMs: 30_000, maxMs: 160_000 },
		);
		assert.ok(final.state.hits.length > 0, "the warm hit remains after the held Sessions index");
		await waitForProgress(() => list.locator(".prose-hit").count(), (count) => String(count ?? 0), (count): count is number => count !== undefined && count > 0, { budgetMs: 15_000, maxMs: 30_000 });
		await list.getByText(/Still reading .*; results may grow\./).waitFor({ state: "detached", timeout: 12_000 });
		assert.ok(await list.locator(".prose-hit").count() > 0, "the palette keeps its result visible after indexing settles");
		assert.equal(await list.getByText(/Still reading .*; results may grow\./).count(), 0, "the pending footer disappears");
		assert.equal((await paletteState(page)).input, WARM_QUERY, "index completion keeps the current query without a new user search");
		assert.ok(await searchCount(page) >= searchesBeforeRelease, "the same pending query may poll while the index drains");
		assert.equal(page.url(), routeBeforeRelease, "index completion does not navigate");
	});
}
