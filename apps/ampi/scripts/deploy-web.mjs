#!/usr/bin/env node
// Usage: node deploy-web.mjs <checkout> <cacheDir>
//        node deploy-web.mjs --served <port> <checkout> <cacheDir>   (smoke row b; see servedBundle)
// Puts the web build of <checkout> into apps/ampi/web/dist for the live deploy, and skips Vite when the inputs are unchanged.
// A cache entry is <cacheDir>/<key>/{dist,inputs.json}. The key hashes the content of every module Vite loaded for that
// build, plus the build configuration, the lock file and the Node version. A new import changes an existing input, so
// a lookup that recomputes each entry's key over the current files is exact.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCHEMA = "deploy-web/2";
const KEEP = 8;
const MARK = ".deploy-web-key";
// Inputs that shape the build without being modules. build() adds the resolved vite and plugin-react package.json.
export const FIXED = [
	"apps/ampi/web/vite.config.ts",
	"apps/ampi/web/tsconfig.json",
	"apps/ampi/web/index.html",
	"apps/ampi/package.json",
	"package.json",
	"package-lock.json",
];

function hashFile(file, memo) {
	if (!memo.has(file)) {
		memo.set(file, existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing");
	}
	return memo.get(file);
}

// Inputs inside the checkout are relative paths, so one cache serves every checkout; inputs outside it are absolute.
// The memo shares file hashes across the entries of one lookup.
export function inputKey(checkout, inputs, memo = new Map()) {
	const h = createHash("sha256").update(`${SCHEMA}\0${process.version}\0`);
	for (const p of [...new Set([...FIXED, ...inputs])].sort()) h.update(`${p}\0${hashFile(resolve(checkout, p), memo)}\0`);
	return h.digest("hex");
}

// Newest entry whose recorded inputs still hash to its key in <checkout>.
export function findCached(checkout, cacheDir) {
	const memo = new Map();
	for (const key of entries(cacheDir)) {
		try {
			const inputs = JSON.parse(readFileSync(join(cacheDir, key, "inputs.json"), "utf8"));
			if (inputKey(checkout, inputs, memo) === key && existsSync(join(cacheDir, key, "dist", "index.html"))) return key;
		} catch {}
	}
	return null;
}

function entries(cacheDir) {
	if (!existsSync(cacheDir)) return [];
	return readdirSync(cacheDir)
		.filter((k) => /^[0-9a-f]{64}$/.test(k))
		.map((k) => ({ k, t: statSync(join(cacheDir, k)).mtimeMs }))
		.sort((a, b) => b.t - a.t)
		.map((e) => e.k);
}

async function build(checkout, cacheDir) {
	const app = join(checkout, "apps/ampi");
	const req = createRequire(join(app, "package.json"));
	const vite = await import(pathToFileURL(req.resolve("vite")).href);
	// The package.json that Node resolution finds for each build tool (plugin-react does not export ./package.json).
	const tools = ["vite", "@vitejs/plugin-react"].map((name) => {
		const dir = req.resolve.paths(name).find((d) => existsSync(join(d, name, "package.json")));
		if (!dir) throw new Error(`cannot find ${name}/package.json`);
		return realpathSync(join(dir, name, "package.json"));
	});
	const out = join(cacheDir, `build-${process.pid}`);
	const ids = new Set();
	await vite.build({
		configFile: join(app, "web/vite.config.ts"),
		root: join(app, "web"),
		logLevel: "warn",
		build: { outDir: out, emptyOutDir: true },
		plugins: [{
			name: "deploy-web-inputs",
			buildEnd() {
				for (const id of this.getModuleIds()) ids.add(id);
			},
		}],
	});
	const inputs = [...ids, ...tools]
		.filter((id) => !id.startsWith("\0"))
		.map((id) => id.replace(/[?#].*$/, ""))
		.filter((file) => isAbsolute(file) && existsSync(file))
		// Outside the checkout (a symlinked node_modules) a relative path would name another file from another checkout.
		.map((file) => (relative(checkout, file).startsWith("..") ? file : relative(checkout, file)));
	if (!inputs.includes("apps/ampi/web/src/main.tsx")) throw new Error(`the recorded inputs (${inputs.length}) lack web/src/main.tsx`);
	const key = inputKey(checkout, inputs);
	rmSync(join(cacheDir, key), { recursive: true, force: true });
	mkdirSync(join(cacheDir, key));
	renameSync(out, join(cacheDir, key, "dist"));
	writeFileSync(join(cacheDir, key, "inputs.json"), `${JSON.stringify(inputs.sort(), null, 1)}\n`);
	return { key, inputs: inputs.length };
}

// Swap the entry into web/dist; the old dist stays in place until the new one is complete.
function install(checkout, cacheDir, key) {
	const dist = join(checkout, "apps/ampi/web/dist");
	const next = `${dist}.next-${process.pid}`;
	const prev = `${dist}.prev-${process.pid}`;
	rmSync(next, { recursive: true, force: true });
	cpSync(join(cacheDir, key, "dist"), next, { recursive: true });
	writeFileSync(join(next, MARK), `${key}\n`);
	if (existsSync(dist)) renameSync(dist, prev);
	renameSync(next, dist);
	rmSync(prev, { recursive: true, force: true });
}

// Smoke row b: the hub serves the build keyed for <checkout>'s current inputs. It reads index.html and every
// /assets/ file that index.html names over HTTP and compares their sha256 with the cache entry's dist.
// A skipped or stale web step fails here even when the hub is healthy.
export async function servedBundle({ port, checkout, cacheDir, headers = {} }) {
	const key = findCached(checkout, cacheDir);
	if (!key) return { ok: false, line: "no keyed build for the checkout's web inputs" };
	const dist = join(cacheDir, key, "dist");
	const sha = (buf) => createHash("sha256").update(buf).digest("hex");
	const get = async (path) => {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(10000) });
		if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
		return Buffer.from(await r.arrayBuffer());
	};
	const index = readFileSync(join(dist, "index.html"));
	const paths = ["/", ...new Set([...index.toString().matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
	const bad = [];
	for (const p of paths) {
		const want = sha(p === "/" ? index : readFileSync(join(dist, p)));
		try { if (sha(await get(p)) !== want) bad.push(p); } catch (e) { bad.push(`${p} (${e.message})`); }
	}
	const what = `${key.slice(0, 12)} index+${paths.length - 1} assets`;
	return bad.length ? { ok: false, line: `served bundle differs from ${what}: ${bad.join(" ")}` } : { ok: true, line: `served = ${what}` };
}

function prune(cacheDir, keep) {
	for (const k of entries(cacheDir).slice(KEEP)) if (k !== keep) rmSync(join(cacheDir, k), { recursive: true, force: true });
}

async function main([checkout, cacheDir, ...rest]) {
	if (checkout === "--served") {
		// node deploy-web.mjs --served <port> <checkout> <cacheDir>: smoke row b alone, for sims and manual checks.
		const r = await servedBundle({ port: Number(cacheDir), checkout: resolve(rest[0]), cacheDir: rest[1] });
		console.log(`${r.ok ? "PASS" : "FAIL"} b=${r.ok ? "ok" : "stale bundle"} | ${r.line}`);
		process.exit(r.ok ? 0 : 1);
	}
	if (!checkout || !cacheDir) throw new Error("usage: deploy-web.mjs <checkout> <cacheDir> | --served <port> <checkout> <cacheDir>");
	checkout = resolve(checkout);
	mkdirSync(cacheDir, { recursive: true });
	const t0 = Date.now();
	let key = findCached(checkout, cacheDir);
	let how = "cached";
	if (!key) ({ key } = await build(checkout, cacheDir), how = "built");
	// The touch marks the entry as newest for lookup and pruning.
	utimesSync(join(cacheDir, key), new Date(), new Date());
	const mark = join(checkout, "apps/ampi/web/dist", MARK);
	if (existsSync(mark) && readFileSync(mark, "utf8").trim() === key) how += ", dist already current";
	else install(checkout, cacheDir, key);
	prune(cacheDir, key);
	console.log(`web ${how} ${key.slice(0, 12)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// deploy-live.sh runs a copy under mktemp -d; on macOS that path goes through the /var symlink.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((err) => {
		console.error(`deploy-web: ${err.stack || err}`);
		process.exit(1);
	});
}
