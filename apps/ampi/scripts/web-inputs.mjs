// The inputs of a web build, shared by deploy-web.mjs (cache key) and web/vite.config.ts (stamp).
// Every build of web/vite.config.ts, plain `npm run build:web` included, writes web/dist/.web-inputs.json (STAMP): the
// sha256 of each input. Disposable hubs (scripts/pi-demo.ts, verify) serve web/dist as it is and refuse a dist whose
// inputs changed since. This module has no main: Vite inlines it into the bundled config.
// Paths: an input inside the checkout is recorded relative to it, so one deploy cache entry serves every checkout with
// the same files. An input outside it (a symlinked node_modules) stays absolute, because a relative path would name
// another checkout's file; a cache entry with such inputs hits only where they resolve to the same files. The stamp
// can therefore hold machine paths, and the hub never serves dotfiles from web/dist (src/hub/hub.ts).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";

export const STAMP = ".web-inputs.json";
const BUILD_FIX = "run npm run build:web -w @hypercarrier/ampi";

// Inputs that shape the build without being modules. buildInputs() adds the resolved vite and plugin-react package.json.
export const FIXED = [
	"apps/ampi/web/vite.config.ts",
	"apps/ampi/web/tsconfig.json",
	"apps/ampi/web/index.html",
	"apps/ampi/package.json",
	"package.json",
	"package-lock.json",
];

export function hashFile(file, memo) {
	if (!memo.has(file)) {
		memo.set(file, existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing");
	}
	return memo.get(file);
}

// The build inputs from Vite's module ids plus the package.json that Node resolution finds for each build tool
// (plugin-react does not export ./package.json).
export function buildInputs(checkout, ids) {
	const req = createRequire(join(checkout, "apps/ampi/package.json"));
	const tools = ["vite", "@vitejs/plugin-react"].map((name) => {
		const dir = req.resolve.paths(name).find((d) => existsSync(join(d, name, "package.json")));
		if (!dir) throw new Error(`cannot find ${name}/package.json`);
		return realpathSync(join(dir, name, "package.json"));
	});
	const inputs = [...ids, ...tools]
		.filter((id) => !id.startsWith("\0"))
		.map((id) => id.replace(/[?#].*$/, ""))
		.filter((file) => isAbsolute(file) && existsSync(file))
		// Outside the checkout (a symlinked node_modules) a relative path would name another file from another checkout.
		.map((file) => (relative(checkout, file).startsWith("..") ? file : relative(checkout, file)));
	if (!inputs.includes("apps/ampi/web/src/main.tsx")) throw new Error(`the recorded inputs (${inputs.length}) lack web/src/main.tsx`);
	return [...new Set(inputs)].sort();
}

export function writeStamp(checkout, outDir, inputs) {
	const memo = new Map();
	const files = Object.fromEntries([...new Set([...FIXED, ...inputs])].sort().map((p) => [p, hashFile(resolve(checkout, p), memo)]));
	writeFileSync(join(outDir, STAMP), `${JSON.stringify({ schema: "web-inputs/1", files }, null, 1)}\n`);
}

/** Vite plugin for web/vite.config.ts: after a build writes its bundle, record its inputs in <outDir>/STAMP. */
export function webInputsPlugin(checkout) {
	let outDir;
	const ids = new Set();
	return {
		name: "ampi-web-inputs",
		apply: "build",
		configResolved(config) {
			outDir = resolve(config.root, config.build.outDir);
		},
		buildEnd() {
			for (const id of this.getModuleIds()) ids.add(id);
		},
		writeBundle() {
			writeStamp(checkout, outDir, buildInputs(checkout, ids));
		},
	};
}

/** Whether <checkout>/apps/ampi/web/dist was built from the current files; detail names the fix when it was not. */
export function webDistCurrent(checkout) {
	const dist = join(checkout, "apps/ampi/web/dist");
	if (!existsSync(join(dist, "index.html"))) return { ok: false, detail: `web/dist is not built; ${BUILD_FIX}` };
	let files;
	try {
		files = JSON.parse(readFileSync(join(dist, STAMP), "utf8")).files;
	} catch {
		return { ok: false, detail: `web/dist has no ${STAMP}, so its inputs are unknown; ${BUILD_FIX}` };
	}
	const memo = new Map();
	const changed = Object.entries(files).filter(([p, sha]) => hashFile(resolve(checkout, p), memo) !== sha).map(([p]) => p);
	if (!changed.length) return { ok: true, detail: `web/dist matches its ${Object.keys(files).length} inputs` };
	const more = changed.length > 3 ? ` and ${changed.length - 3} more` : "";
	return { ok: false, detail: `web/dist is stale: ${changed.slice(0, 3).join(", ")}${more} changed since the build; ${BUILD_FIX}` };
}
