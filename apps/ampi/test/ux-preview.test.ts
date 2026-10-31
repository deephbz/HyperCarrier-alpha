import "./bound.ts";
// Generated AmPi previews (scripts/ux/preview.mjs): arguments, side resolution, scene selection, crop and diff math, and
// the gallery. The end-to-end run (two builds, two hubs) is the preview command itself; these cases need no hub.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
// @ts-ignore: plain ESM
import { findChrome } from "../scripts/perf/browser.mjs";
// @ts-ignore: plain ESM
import { cropBox, parseArgs, resolveSide, selectScenes, shotsOf, verdict } from "../scripts/ux/preview-core.mjs";
// @ts-ignore: plain ESM
import { renderGallery } from "../scripts/ux/gallery.mjs";
// @ts-ignore: plain ESM
import { diffPngs } from "../scripts/ux/pixels.mjs";
// @ts-ignore: plain ESM
import { recipes } from "../scripts/ux/recipes.mjs";
// @ts-ignore: plain ESM
import { setup, STEPS } from "../scripts/ux/setup.mjs";
// @ts-ignore: plain ESM
import { pinHubClock, routeFixture } from "../scripts/ux/fixtures.mjs";
import { DEMO_EXTENSIONS } from "../scripts/demo/index.ts";
import { writeDemoSessions } from "../scripts/demo/sessions.ts";

test("the demo seed dates every file from its seed clock: one `now` writes the same bytes at any wall-clock time", () => {
	const now = Date.UTC(2026, 9, 30, 9);
	const seed = (wall: number) => {
		const dir = mkdtempSync(join(tmpdir(), "ux-seed-"));
		mock.timers.enable({ apis: ["Date"], now: wall });
		try {
			const agentDir = join(dir, "agent");
			const sessions = writeDemoSessions(agentDir, now);
			for (const extend of DEMO_EXTENSIONS) extend({ dir, agentDir, now, sessions });
			return Object.fromEntries(readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.(jsonl|json|cjs)$/.test(f)).sort()
				.map((f) => [f, readFileSync(join(dir, f), "utf8").split(dir).join("<dir>")]));
		} finally {
			mock.timers.reset();
			rmSync(dir, { recursive: true, force: true });
		}
	};
	const early = seed(now + 60_000), late = seed(now + 7 * 3_600_000);
	assert.ok(Object.keys(early).length > 10);
	assert.deepEqual(late, early);
});

test("every recipe names a setup step that exists; an unknown step fails the scene", async () => {
	const unknown = recipes.filter((r: { setup?: string }) => r.setup && !(r.setup in STEPS)).map((r: { id: string }) => r.id);
	assert.deepEqual(unknown, []);
	await assert.rejects(setup({ locator: () => ({ count: async () => 0 }) }, { id: "X.a", setup: "retired-control" }), /X\.a: unknown setup step 'retired-control'/);
});

test("verdict: a failed scene setup fails any run; a changed shot fails an A/A run only", () => {
	const shot = (key: string, changed: number, error?: string) => ({ key, sides: { before: { image: "b" }, after: { image: "a", ...(error ? { error } : {}) } }, diff: { changed } });
	const same = { base: { sha: "a1" }, head: { sha: "a1" }, variants: [] };
	assert.deepEqual(verdict({ ...same, shots: [shot("S01.a.light", 0)] }), { ok: true, aa: true, failed: [], drift: [] });
	assert.deepEqual(verdict({ ...same, shots: [shot("S01.a.light", 0, "Timeout"), shot("S04.d.dark", 60)] }), { ok: false, aa: true, failed: ["head S01.a.light"], drift: ["S04.d.dark"] });
	assert.equal(verdict({ ...same, head: { sha: "b2" }, shots: [shot("S04.d.dark", 60)] }).ok, true);
	assert.equal(verdict({ ...same, variants: ["x"], shots: [shot("S04.d.dark", 60)] }).ok, true);
	assert.equal(verdict({ ...same, head: { sha: "b2" }, shots: [shot("S04.d.dark", 0, "Timeout")] }).ok, false);
});

test("a scene shows hub-clock values at the page clock: frames from two hub runs show the same values", () => {
	const clock = Date.UTC(2026, 9, 30, 9, 10);
	const frames = (at: number) => ({
		hosts: [{ id: "devbox", status: "disconnected", since: at, lastSeen: at - 4000, retryAt: at + 3000, latencyMs: at % 97 }],
		threads: { threads: { "pi:a": { updatedAt: 1, arc: { builtAt: new Date(at).toISOString(), stale: false } } } },
		thread: { entries: [], agent: { cwd: "/w", asOf: at }, live: { retry: { at, error: "x" } } },
		view: { diagnosis: { entries: 3, ms: at % 300 }, source: { state: "ready", asOf: at }, keptAt: new Date(at).toISOString(), context: { builtAt: new Date(at).toISOString() },
			synthesis: { builtAt: new Date(at).toISOString() }, builds: [{ startedAt: at, endedAt: at + 9 }], arcBuilds: [{ startedAt: at, endedAt: at + 9 }],
			sessions: [{ source: { asOf: at }, head: { builtAt: new Date(at).toISOString() } }] },
	});
	const pinned = (at: number) => Object.fromEntries(Object.entries(frames(at)).map(([kind, value]) => [kind, pinHubClock(kind, value, clock)]));
	assert.deepEqual(pinned(clock + 7_000), pinned(clock + 3_600_000));
	assert.equal(pinned(clock + 7_000).threads.threads["pi:a"].updatedAt, 1, "seeded Session data keeps its value");
});

test("routeFixture owns the fixture clock: a given clock fixes the page clock and pins the hub; none leaves both on the wall clock", async () => {
	const route = async (clock?: number) => {
		const fixed: number[] = [], shown: { hosts: { since: number; retryAt: number }[] }[] = [];
		let hub: (raw: string) => void = () => {};
		const page = {
			clock: { setFixedTime: async (at: number) => { fixed.push(at); } },
			routeWebSocket: async (_: string, handler: (ws: unknown) => void) => handler({
				connectToServer: () => ({ send: () => {}, onMessage: (fn: typeof hub) => { hub = fn; } }),
				onMessage: () => {}, send: (raw: string) => shown.push(JSON.parse(raw)),
			}),
		};
		await routeFixture(page, {}, { requests: [] }, clock === undefined ? {} : { clock });
		hub(JSON.stringify({ t: "hosts", hosts: [{ id: "devbox", status: "connected", since: 5, retryAt: 7 }] }));
		const { since, retryAt } = shown[0]!.hosts[0]!;
		return { fixed, host: { since, retryAt } };
	};
	const clock = Date.UTC(2026, 9, 30, 9, 10);
	assert.deepEqual(await route(clock), { fixed: [clock], host: { since: clock, retryAt: clock } });
	assert.deepEqual(await route(), { fixed: [], host: { since: 5, retryAt: 7 } });
});

test("parseArgs: base and head are required; --only, --themes and --variants narrow or widen the run", () => {
	assert.deepEqual(parseArgs(["--base", "main", "--head", "topic", "--only", "S03.x,S12.a"]), { base: "main", head: "topic", only: ["S03.x", "S12.a"], themes: ["light", "dark"], variants: [], motion: "reduce", out: undefined });
	assert.equal(parseArgs(["--base", "a", "--head", "b"]).only, undefined);
	assert.deepEqual(parseArgs(["--base", "a", "--head", "b", "--themes", "dark", "--variants", "x,y"]).variants, ["x", "y"]);
	assert.throws(() => parseArgs(["--head", "b"]), /--base/);
	assert.throws(() => parseArgs(["--base", "a"]), /--head/);
	assert.throws(() => parseArgs(["--base", "a", "--head", "b", "--themes", "sepia"]), /theme/);
	assert.throws(() => parseArgs(["--base", "a", "--head", "b", "--bogus"]), /--bogus/);
	assert.equal(parseArgs(["--base", "a", "--head", "b", "--motion", "no-preference"]).motion, "no-preference");
	assert.throws(() => parseArgs(["--base", "a", "--head", "b", "--motion", "fast"]), /motion/);
});

test("resolveSide: a ref is its commit; a worktree path is a commit of its tracked edits and stays untouched", () => {
	const repo = mkdtempSync(join(tmpdir(), "ampi-preview-git-"));
	after(() => rmSync(repo, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git("add", ".");
	git("commit", "-qm", "one");
	const head = git("rev-parse", "HEAD");
	assert.deepEqual(resolveSide(repo, "HEAD"), { spec: "HEAD", kind: "ref", sha: head, base: head, untracked: [], submodules: [], note: `HEAD = ${head}` });
	// A clean worktree path is its HEAD.
	const clean = resolveSide(repo, repo);
	assert.equal(clean.sha, head);
	assert.equal(clean.note, `${repo} = HEAD ${head} (clean)`);
	writeFileSync(join(repo, "a.txt"), "two\n");
	writeFileSync(join(repo, "new.txt"), "untracked\n");
	const dirty = resolveSide(repo, repo);
	assert.equal(dirty.kind, "worktree");
	assert.notEqual(dirty.sha, head);
	assert.equal(dirty.base, head);
	assert.equal(dirty.note, `${repo} = stash of ${head} + tracked edits`);
	assert.equal(execFileSync("git", ["show", `${dirty.sha}:a.txt`], { cwd: repo, encoding: "utf8" }), "two\n");
	assert.deepEqual(dirty.untracked, ["new.txt"]);
	// Untouched: the edit is still in the tree, nothing is stashed, HEAD did not move.
	assert.equal(git("status", "--porcelain"), "M a.txt\n?? new.txt");
	assert.equal(git("stash", "list"), "");
	assert.equal(git("rev-parse", "HEAD"), head);
	assert.throws(() => resolveSide(repo, "no-such-ref"), /no-such-ref/);
});

test("selectScenes: scenes are recipes; no --only runs every recipe; the proof scenes name a target and their owner request", () => {
	assert.throws(() => selectScenes(recipes, ["S99.z"]), /S99\.z/);
	assert.equal(selectScenes(recipes, undefined).length, recipes.length);
	const [chip, sidebar] = selectScenes(recipes, ["S03.x", "S12.a"]);
	assert.equal(chip.target, ".new-below button");
	assert.equal(chip.live, true);
	assert.equal(chip.serves.date, "2026-10-30");
	assert.match(chip.serves.words, /X new messages, Y tool use/);
	assert.match(sidebar.serves.words, /green dot/);
	// Every recipe id stays unique: the preview adds no second inventory.
	assert.equal(new Set(recipes.map((r: { id: string }) => r.id)).size, recipes.length);
});

test("scene places: a reader's place is a seeded entry ID behind the route's ?e= link; no step writes a scroll offset or waits a time", () => {
	// A pixel offset or a timed wait captures a place that depends on how much has painted or arrived (an A/A drift).
	const steps = readFileSync(new URL("../scripts/ux/setup.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(steps, /scrollTop\s*[-+]?=|\.scroll(To|By)\(|waitForTimeout\(/);
	const dir = mkdtempSync(join(tmpdir(), "ux-read-"));
	try {
		writeDemoSessions(dir, Date.UTC(2026, 9, 30));
		const seeded = readdirSync(join(dir, "sessions"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl"))
			.flatMap((f) => readFileSync(join(dir, "sessions", f), "utf8").trim().split("\n").map((line) => JSON.parse(line).id));
		const placed = recipes.filter((r: { read?: string }) => r.read);
		assert.deepEqual(placed.map((r: { id: string }) => r.id), ["S03.w", "S03.x", "S13.a", "S13.b", "S13.c", "S13.d"]);
		for (const r of placed) {
			// The long-turn variant copies a seeded tool call 300 times as `<id>-0` … `<id>-299`.
			const copy = r.variant === "long-turn" ? /^(.+)-(\d+)$/.exec(r.read) : null;
			if (copy) assert.ok(Number(copy[2]) < 300, `${r.id} reads copy ${copy[2]}, past the last of 300`);
			assert.ok(seeded.includes(copy ? copy[1] : r.read), `${r.id} reads ${r.read}, which the demo seed does not write`);
			assert.equal(new URLSearchParams(r.route.split("?")[1]).get("e"), r.read, `${r.id}'s route links its read entry`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("shotsOf: one shot per theme unless the scene pins one; a variant names the head shot", () => {
	assert.deepEqual(shotsOf({ id: "A" }, ["light", "dark"]).map((s: { key: string }) => s.key), ["A.light", "A.dark"]);
	assert.deepEqual(shotsOf({ id: "B", theme: "dark" }, ["light", "dark"]).map((s: { key: string }) => s.key), ["B.dark"]);
	assert.deepEqual(shotsOf({ id: "A" }, ["light"], "x").map((s: { key: string }) => s.key), ["A.light.x"]);
});

test("cropBox: the union of the target boxes plus padding, clamped to the viewport, in whole pixels", () => {
	const viewport = { width: 1280, height: 900 };
	assert.deepEqual(cropBox([{ x: 100.4, y: 50.6, width: 200, height: 30 }], viewport, 24), { x: 76, y: 26, width: 249, height: 79 });
	assert.deepEqual(cropBox([{ x: 5, y: 880, width: 300, height: 40 }], viewport, 24), { x: 0, y: 856, width: 329, height: 44 });
	assert.deepEqual(cropBox([{ x: 100, y: 100, width: 10, height: 10 }, { x: 200, y: 100, width: 10, height: 30 }], viewport, 0), { x: 100, y: 100, width: 110, height: 30 });
	// No target on either side: the whole viewport.
	assert.deepEqual(cropBox([], viewport, 24), { x: 0, y: 0, width: 1280, height: 900 });
});

let browser: Browser;
let page: Page;
before(async () => {
	browser = await chromium.launch({ headless: true, executablePath: findChrome() });
	page = await browser.newPage();
});
after(async () => {
	await browser?.close();
});

/** A PNG with a solid background and an optional red square, drawn in the test page. */
async function png(width: number, height: number, square?: { x: number; y: number; size: number }): Promise<Buffer> {
	const data = await page.evaluate(({ width, height, square }) => {
		const c = document.createElement("canvas");
		c.width = width;
		c.height = height;
		const g = c.getContext("2d")!;
		g.fillStyle = "#ffffff";
		g.fillRect(0, 0, width, height);
		if (square) {
			g.fillStyle = "#ff0000";
			g.fillRect(square.x, square.y, square.size, square.size);
		}
		return c.toDataURL("image/png").split(",")[1];
	}, { width, height, square });
	return Buffer.from(data, "base64");
}

test("diffPngs: full images; identical gives 0; changes inside and outside the target boxes count apart", async () => {
	const a = await png(40, 30);
	const same = await diffPngs(page, a, await png(40, 30), []);
	assert.deepEqual([same.changed, same.outside, same.total], [0, 0, 1200]);
	// A 5x5 square: 3 columns fall in the target box (x 0..4), 2 outside it.
	const changed = await diffPngs(page, a, await png(40, 30, { x: 2, y: 3, size: 5 }), [{ x: 0, y: 0, width: 5, height: 30 }]);
	assert.deepEqual([changed.changed, changed.outside], [25, 10]);
	assert.equal(changed.png.toString("hex", 0, 8), "89504e470d0a1a0a");
	// A size change counts every pixel outside the shared area.
	const wider = await diffPngs(page, a, await png(50, 30), []);
	assert.deepEqual([wider.changed, wider.total], [300, 1500]);
});

test("renderGallery: before | after | diff per shot, owner words or AGENT-ORIGINATED, rings, coverage and warnings", async () => {
	const box = { x: 10, y: 20, width: 30, height: 15 };
	const shot = (scene: object, changed: number, outside: number, sides?: object) => ({
		scene: { family: "Session", ...scene },
		theme: "light",
		key: `${(scene as { id: string }).id}.light`,
		viewport: { width: 1280, height: 900 },
		crop: { x: 0, y: 0, width: 100, height: 80 },
		sides: sides ?? { before: { image: "base/k.png", box }, after: { image: "head/k.png", box: { ...box, height: 25 } } },
		diff: { image: "diff/k.png", changed, outside, total: 1_152_000 },
	});
	const html = renderGallery({
		base: { spec: "origin/main", sha: "a".repeat(40), note: "origin/main = aaaa" },
		head: { spec: "/w/ampi-ui", sha: "b".repeat(40), note: "/w/ampi-ui = stash of cccc + tracked edits" },
		coverage: { ran: ["S01.a", "S12.a", "S03.x"], notRun: ["S02.a", "S02.b"] },
		warnings: ["head: untracked files not captured: apps/ampi/web/src/new.tsx"],
		shots: [
			shot({ id: "S01.a", title: "Timeline <tokens>" }, 0, 0),
			shot({ id: "S12.a", title: "Sidebar · Team expanded", serves: { date: "2026-10-30", words: '"the “live” after hostID"' } }, 6000, 2000),
			shot({ id: "S03.x", title: "Session · new-below chip" }, 900, 0, { before: { image: "base/x.png" }, after: { image: "head/x.png", box } }),
		],
	});
	await page.setContent(html);
	const cards = page.locator("article.shot");
	assert.equal(await cards.count(), 3);
	// Sorted by total change; the percentage is a sort key, never a pass or fail colour.
	assert.deepEqual(await cards.evaluateAll((cs) => cs.map((c) => c.getAttribute("data-scene"))), ["S12.a", "S03.x", "S01.a"]);
	assert.doesNotMatch(html, /\b(pass|fail)\b/i);
	const top = cards.first();
	assert.match(await top.locator(".serves").innerText(), /Owner 2026-10-30: "the “live” after hostID"/);
	assert.match(await top.innerText(), /2,000 px changed outside target/);
	assert.match(await cards.nth(2).locator(".serves").innerText(), /AGENT-ORIGINATED/);
	assert.match(await cards.nth(2).innerText(), /Timeline <tokens>/);
	assert.match(await cards.nth(2).innerText(), /no change/);
	// A target absent on one side is a card result.
	assert.match(await cards.nth(1).innerText(), /not present in base/);
	// Each side's ring is that side's own measured box, relative to the crop.
	assert.deepEqual(await top.locator("svg rect.ring").evaluateAll((rs) => rs.map((r) => r.getAttribute("height"))), ["15", "25"]);
	assert.equal(await top.locator("img").count(), 3);
	assert.match(await page.locator("header").innerText(), /ran 3 of 5/);
	assert.match(await page.locator("header").innerText(), /S02\.a, S02\.b/);
	assert.match(await page.locator("header").innerText(), /stash of cccc \+ tracked edits/);
	assert.match(await page.locator(".warnings").innerText(), /untracked files not captured/);
	assert.doesNotMatch(html, /<tokens>/);
});
