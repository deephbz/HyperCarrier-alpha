import "./bound.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-ignore: the deploy scripts are plain ESM.
import { FIXED, findCached, inputKey, servedBundle } from "../scripts/deploy-web.mjs";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));

function put(root: string, rel: string, text: string) {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), text);
}

// A cache entry as deploy-web.mjs stores it after a build of <checkout>.
function entry(cacheDir: string, checkout: string, inputs: string[], age = 0, dist: Record<string, string> = {}) {
	const key: string = inputKey(checkout, inputs);
	const files = { "index.html": `<!-- ${key} -->`, ...dist };
	for (const [rel, text] of Object.entries(files)) put(join(cacheDir, key, "dist"), rel, text);
	put(join(cacheDir, key), "inputs.json", JSON.stringify(inputs));
	const t = new Date(Date.now() - age * 1000);
	utimesSync(join(cacheDir, key), t, t);
	return key;
}

function scratch(t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(tmpdir(), "deploy-web-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, checkout: join(root, "checkout"), cache: join(root, "cache") };
}

test("deploy-web cache key: same inputs hit, a changed input or build file misses, a revert hits again", (t) => {
	const { checkout, cache } = scratch(t);
	const inputs = ["apps/ampi/web/src/main.tsx", "apps/ampi/src/shared/protocol.ts", "node_modules/react/index.js"];
	for (const p of [...inputs, ...FIXED]) put(checkout, p, `v1 ${p}`);
	const key = entry(cache, checkout, inputs);

	assert.equal(findCached(checkout, cache), key);

	put(checkout, "apps/ampi/src/shared/protocol.ts", "v2");
	assert.equal(findCached(checkout, cache), null, "a changed module input must rebuild");
	put(checkout, "apps/ampi/src/shared/protocol.ts", "v1 apps/ampi/src/shared/protocol.ts");
	assert.equal(findCached(checkout, cache), key, "a revert finds the earlier build");

	put(checkout, "package-lock.json", "v2");
	assert.equal(findCached(checkout, cache), null, "a changed lock file must rebuild");
	put(checkout, "package-lock.json", "v1 package-lock.json");

	put(checkout, "apps/ampi/web/src/unused.ts", "not imported");
	assert.equal(findCached(checkout, cache), key, "a file outside the module graph does not rebuild");
});

test("deploy-web cache key: an input outside the checkout is absolute, so two checkouts share the entry", (t) => {
	const { root, checkout, cache } = scratch(t);
	const shared = join(root, "shared/node_modules/react/index.js");
	put(root, "shared/node_modules/react/index.js", "react v1");
	put(checkout, "a.ts", "a");
	const other = join(root, "elsewhere/deeper/checkout");
	put(other, "a.ts", "a");
	const key = entry(cache, checkout, ["a.ts", shared]);
	assert.equal(findCached(other, cache), key);
	put(root, "shared/node_modules/react/index.js", "react v2");
	assert.equal(findCached(other, cache), null);
});

// deploy-live.sh runs a copy from mktemp -d, which on macOS sits behind the /var symlink.
test("deploy-web runs its main when started through a symlinked path", (t) => {
	const { root } = scratch(t);
	symlinkSync(scripts, join(root, "link"));
	const run = spawnSync(process.execPath, [join(root, "link", "deploy-web.mjs")], { encoding: "utf8" });
	assert.equal(run.status, 1);
	assert.match(run.stderr, /usage: deploy-web\.mjs/);
});

test("deploy-web cache lookup: the newest matching entry wins, and an entry without a dist misses", (t) => {
	const { checkout, cache } = scratch(t);
	put(checkout, "a.ts", "a");
	put(checkout, "b.ts", "b");
	const older = entry(cache, checkout, ["a.ts"], 60);
	const newer = entry(cache, checkout, ["a.ts", "b.ts"]);
	assert.equal(findCached(checkout, cache), newer);
	rmSync(join(cache, newer, "dist"), { recursive: true });
	assert.equal(findCached(checkout, cache), older);
});

// Smoke row b reads the bundle over HTTP, as a browser does, and compares it with the dist keyed for the checkout.
test("smoke row b: the served index and its assets must equal the keyed dist", async (t) => {
	const { checkout, cache } = scratch(t);
	put(checkout, "app.ts", "v1");
	const html = (js: string) => `<script type="module" src="/assets/${js}"></script><link rel="stylesheet" href="/assets/s.css">`;
	const v1 = entry(cache, checkout, ["app.ts"], 60, { "index.html": html("index-v1.js"), "assets/index-v1.js": "js v1", "assets/s.css": "css" });
	// The hub's web/dist: what the server answers at request time.
	const served = join(checkout, "dist");
	const serve = (key: string) => {
		rmSync(served, { recursive: true, force: true });
		for (const rel of ["index.html", "assets/s.css", ...(readFileSync(join(cache, key, "dist/index.html"), "utf8").match(/assets\/index-[^"]+/g) ?? [])]) {
			put(served, rel, readFileSync(join(cache, key, "dist", rel), "utf8"));
		}
	};
	const server = createServer((req, res) => {
		const file = join(served, req.url === "/" ? "index.html" : String(req.url));
		try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
	}).listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => server.close());
	const port = (server.address() as AddressInfo).port;
	const row = () => servedBundle({ port, checkout, cacheDir: cache });

	serve(v1);
	assert.deepEqual(await row(), { ok: true, line: `served = ${v1.slice(0, 12)} index+2 assets` });

	// The target changes a web input, and the web step is skipped: no keyed build exists for it.
	put(checkout, "app.ts", "v2");
	const skipped = await row();
	assert.equal(skipped.ok, false);
	assert.match(skipped.line, /no keyed build/);

	// The target's build exists in the cache, but the hub still serves v1.
	const v2 = entry(cache, checkout, ["app.ts"], 0, { "index.html": html("index-v2.js"), "assets/index-v2.js": "js v2", "assets/s.css": "css" });
	const stale = await row();
	assert.equal(stale.ok, false);
	assert.match(stale.line, new RegExp(`differs from ${v2.slice(0, 12)}.*: / /assets/index-v2\\.js \\(/assets/index-v2\\.js HTTP 404\\)`));

	// Same index, but an asset with other bytes.
	serve(v2);
	put(served, "assets/s.css", "css tampered");
	const asset = await row();
	assert.equal(asset.ok, false);
	assert.match(asset.line, /: \/assets\/s\.css$/);

	serve(v2);
	assert.equal((await row()).ok, true);
});
