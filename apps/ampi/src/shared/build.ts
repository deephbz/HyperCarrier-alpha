// The builds of this AmPi install. `buildId` is the node build: a hash over the inputs a node restart picks up. Nodes
// outlive the hub and windows, so a host can run an older node build than the hub after an update; comparing node
// builds makes that visible. Hub, web and docs files are not node inputs, so a hub-only deploy does not flag a node
// that runs current code. `stamp` is the hub's build (its source and the page it serves): `stamp` here and `compare`
// in skew.ts are the one way AmPi detects a version difference between hub, page and pi-hc-control (P1).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, skewText, type Stamp, stampLabel, VERSION_SKEW } from "./skew.ts";

export { compare, READ_OPS, type Skew, skewText, type Stamp, stampLabel, VERSION_SKEW } from "./skew.ts";

/** The node's entry, relative to the app: `ampi node` starts here. */
const NODE_ROOTS = ["bin/ampi.mjs"];
/**
 * Modules the scan does not enter: cli.ts loads the hub-side commands from here, and `ampi node` never does.
 * test/build-id.test.ts runs the real `ampi node` and fails when it loads any module outside the node build.
 */
const NOT_NODE = new Set(["apps/ampi/src/commands.ts"]);
/** The ID of a node whose inputs could not all be read. It never matches, not even itself. */
export const UNKNOWN_BUILD = "unknown";
const ALGORITHM = "n1";
/** The file in a pinned package that names the commit its dist was built from (scripts/build-pinned-packages.mjs). */
export const BUILD_STAMP = "dist/.source-commit";

/** A pinned package checkout whose dist was not built from the commit the checkout pins. */
export class StalePackageBuild extends Error {
	override name = "StalePackageBuild";
}

const REPO = resolve(fileURLToPath(new URL("../../", import.meta.url)), "../..");
const SOURCE = /\.(ts|mjs|js)$/;
// Static imports and re-exports (type-only ones load nothing), side-effect imports, and dynamic imports of literals.
const IMPORTS = [/(?:^|[\n;])\s*(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s*["']([^"']+)["']/g, /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g];
// Files the node reads beside its own module: `new URL("<file>", import.meta.url)`.
const ASSETS = /\bnew URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;

type NodeBuild = {
	/** `n1-<hash>`, or UNKNOWN_BUILD when an input is missing. */
	id: string;
	/** Repo-relative paths of the hashed files, sorted. */
	files: string[];
	/** `name@version` of each third-party package the node resolves, with its dependencies, sorted. */
	packages: string[];
	/** Inputs that could not be read: a file, a workspace package, or a lock entry. */
	missing: string[];
};

type LockEntry = {
	version?: string;
	integrity?: string;
	link?: boolean;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

/**
 * The lock path Node loads package `name` from, for an importer in repo-relative directory `from` ("" for the root),
 * or undefined. Node's walk-up: `<dir>/node_modules/<name>` for the directory and each parent, nearest first, skipping
 * directories named node_modules. The lock keys its entries by those install paths.
 */
export function lockResolve(lock: Record<string, unknown>, name: string, from: string): string | undefined {
	const parts = from ? from.split("/") : [];
	for (;;) {
		if (parts.at(-1) !== "node_modules") {
			const path = [...parts, "node_modules", name].join("/");
			if (lock[path] !== undefined) return path;
		}
		if (!parts.pop()) return undefined;
	}
}

/** The commit the checkout at `repo` pins at `path` (a submodule gitlink in its index), or undefined. */
function pinnedCommit(repo: string, path: string): string | undefined {
	try {
		const [mode, hash] = execFileSync("git", ["-C", repo, "ls-files", "-s", "--", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\s+/);
		return mode === "160000" ? hash : undefined;
	} catch {
		return undefined;
	}
}

/** The package name of a bare specifier, or undefined for a relative or `node:` one. */
function packageName(specifier: string): string | undefined {
	if (specifier.startsWith(".") || specifier.startsWith("node:") || specifier.startsWith("/")) return undefined;
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The node build of the checkout at `repo`: its inputs, and their hash. */
export function nodeBuild(checkout = REPO): NodeBuild {
	// Workspace links resolve to real paths, so the root must be real too (macOS /var is /private/var).
	const repo = realpathSync(checkout);
	const app = join(repo, "apps/ampi");
	const files = new Set<string>();
	/** Third-party imports: `<importer directory>\0<package name>`. */
	const external = new Set<string>();
	const missing = new Set<string>();
	const rel = (file: string) => relative(repo, file).split(sep).join("/");
	const lockPath = join(repo, "package-lock.json");
	const lock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as { packages: Record<string, LockEntry> }).packages : undefined;
	if (!lock) missing.add("package-lock.json");

	/** The file a workspace specifier names (a package the lock links to repo source), else undefined. */
	const workspaceFile = (specifier: string, name: string): string | undefined => {
		const entry = lock?.[`node_modules/${name}`];
		if (!entry?.link) return undefined;
		const link = join(repo, "node_modules", name);
		if (!existsSync(link)) return void missing.add(`node_modules/${name}`);
		const dir = realpathSync(link);
		const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
		const exports = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { exports?: Record<string, unknown> }).exports;
		const target = exports?.[subpath] as string | { import?: string; default?: string } | undefined;
		const file = typeof target === "string" ? target : (target?.import ?? target?.default);
		const resolved = resolve(dir, file ?? subpath);
		if (resolved.startsWith(join(dir, "dist") + sep)) checkStamp(dir);
		return resolved;
	};
	/** A pinned package checkout must hold the dist its pinned commit builds, so a pin bump without a rebuild fails. */
	const stamped = new Set<string>();
	const checkStamp = (dir: string) => {
		if (stamped.has(dir)) return;
		stamped.add(dir);
		const pinned = pinnedCommit(repo, rel(dir));
		if (!pinned) return;
		const stamp = join(dir, BUILD_STAMP);
		const built = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : undefined;
		if (built !== pinned) throw new StalePackageBuild(`${rel(dir)}/dist was built from ${built ?? "an unstamped commit"}, but the checkout pins ${pinned}. Run npm run prepare.`);
	};

	const visit = (file: string) => {
		const key = rel(file);
		if (files.has(key) || NOT_NODE.has(key)) return;
		if (!existsSync(file)) return void missing.add(key);
		files.add(key);
		if (!SOURCE.test(file)) return;
		// Whole-line comments only: a `//` inside a string, as in a URL, stays.
		const text = readFileSync(file, "utf8").replace(/^\s*(\/\/|\/\*|\*).*$/gm, "");
		for (const [, asset] of text.matchAll(ASSETS)) {
			const path = resolve(dirname(file), asset!);
			// A directory URL anchors other paths; it is not an input.
			if (!asset!.endsWith("/") && !(existsSync(path) && statSync(path).isDirectory())) visit(path);
		}
		for (const pattern of IMPORTS)
			for (const [, specifier] of text.matchAll(pattern)) {
				if (specifier!.startsWith(".")) {
					visit(resolve(dirname(file), specifier!));
					continue;
				}
				const name = packageName(specifier!);
				if (!name) continue;
				const local = workspaceFile(specifier!, name);
				if (local) visit(local);
				else external.add(`${rel(dirname(file))}\0${name}`);
			}
	};
	for (const root of NODE_ROOTS) visit(join(app, root));

	// Third-party packages by their lock entries, with every dependency they can load.
	const packages = new Set<string>();
	const lockVisit = (name: string, from: string, optional: boolean) => {
		if (!lock) return;
		const path = lockResolve(lock, name, from);
		if (!path) return void (optional || missing.add(`package-lock.json: ${from ? `${from} > ` : ""}${name}`));
		const entry = lock[path]!;
		const id = `${path}@${entry.version ?? ""}#${entry.integrity ?? ""}`;
		if (packages.has(id)) return;
		packages.add(id);
		for (const dependency of Object.keys(entry.dependencies ?? {})) lockVisit(dependency, path, false);
		for (const dependency of Object.keys(entry.optionalDependencies ?? {})) lockVisit(dependency, path, true);
		for (const dependency of Object.keys(entry.peerDependencies ?? {})) lockVisit(dependency, path, entry.peerDependenciesMeta?.[dependency]?.optional === true);
	};
	for (const key of external) {
		const [from, name] = key.split("\0") as [string, string];
		lockVisit(name, from, false);
	}

	const sortedFiles = [...files].sort();
	const sortedPackages = [...packages].sort();
	const hash = createHash("sha256");
	for (const file of sortedFiles) hash.update(`${file}\0`).update(readFileSync(join(repo, file))).update("\0");
	for (const entry of sortedPackages) hash.update(`${entry}\0`);
	const id = missing.size ? UNKNOWN_BUILD : `${ALGORITHM}-${hash.digest("hex").slice(0, 12)}`;
	return { id, files: sortedFiles, packages: sortedPackages.map((p) => p.replace(/^(.*\/)?node_modules\//, "").replace(/#.*$/, "")), missing: [...missing].sort() };
}

let cached: string | undefined;

/** This install's node build ID, computed once per process: a node announces the build it booted with. */
export function buildId(): string {
	cached ??= nodeBuild().id;
	return cached;
}

/** Whether a node's announced build is this install's. An absent, unknown or other-algorithm ID never matches. */
export function sameBuild(announced: string | undefined, local = buildId()): boolean {
	return announced !== undefined && announced !== UNKNOWN_BUILD && local !== UNKNOWN_BUILD && announced === local;
}

/** A hash over the `.ts` files under `root`, with their paths from `/src/` on. */
export function sourceHash(root: string, suffixes: readonly string[] = [".ts"]): string {
	const hash = createHash("sha256");
	const walk = (dir: string) => {
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (suffixes.some((s) => name.endsWith(s))) hash.update(path.slice(path.lastIndexOf("/src/"))).update(readFileSync(path));
		}
	};
	walk(root);
	return hash.digest("hex").slice(0, 12);
}

/** The HEAD committer time of the checkout that holds `dir`. A build without git metadata has no order: it throws. */
export function buildOrder(dir: string): number {
	let out = "";
	try {
		out = execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {}
	const order = Number(out);
	if (!Number.isInteger(order) || order <= 0) throw new Error(`No build order: ${dir} is not in a git checkout with a commit, so AmPi cannot stamp its build.`);
	return order;
}

const APP = fileURLToPath(new URL("../../", import.meta.url));

/** The release line of the checkout: the durable line carries its export fragment. Informational only. */
export function releaseLine(app = APP): Stamp["line"] {
	return existsSync(join(app, "../../release/public/export-manifest.durable.json")) ? "durable" : "stable";
}

let hubStamp: Stamp | undefined;
/**
 * This hub's stamp: its source and the web page it serves (web/dist/index.html names every hashed bundle file), so a
 * page served by another build reads another stamp. Computed once per process.
 */
export function stamp(): Stamp {
	if (hubStamp) return hubStamp;
	const hash = createHash("sha256").update(sourceHash(join(APP, "src")));
	const index = join(APP, "web/dist/index.html");
	if (existsSync(index)) hash.update(readFileSync(index));
	hubStamp = { id: hash.digest("hex").slice(0, 12), order: buildOrder(APP), line: releaseLine() };
	return hubStamp;
}

let expectedControl: Stamp | undefined;
/**
 * The pi-hc-control stamp this hub expects: the package in this checkout, by the rule its `src/stamp.ts` follows
 * (the `.ts` files under src/, the HEAD committer time). Computed once per process; a checkout without the package
 * or without git metadata throws.
 */
export function controlStamp(): Stamp {
	if (expectedControl) return expectedControl;
	const src = join(APP, "../../packages/pi-hc-control/src");
	if (!existsSync(src)) throw new Error(`No pi-hc-control at ${src}, so AmPi cannot stamp the control it serves.`);
	expectedControl = { id: sourceHash(src, [".ts"]), order: buildOrder(src), line: releaseLine() };
	return expectedControl;
}

/**
 * The build drift of a Host's pi-hc-control, or undefined when it runs this build. `control` is the stamp its status
 * reports; null means it reported none (no git metadata). Drift never refuses an op: the deploy parts row shows the
 * message and the hub logs `detail`, which names both stamps.
 */
export function controlSkew(expected: Stamp, control: Stamp | null | undefined, host: string): (Error & { code: string; detail: string }) | undefined {
	const skew = control ? compare(expected, control) : "unstamped";
	if (skew === "same") return undefined;
	const message = skew === "older" ? skewText.controlOlder(host, control!.id) : skew === "newer" ? skewText.controlNewer(host) : skewText.controlUnstamped(host);
	const detail = `pi-hc-control on ${host}: ${stampLabel(control)}; this AmPi expects ${stampLabel(expected)}.`;
	return Object.assign(new Error(message), { code: VERSION_SKEW, detail });
}

/**
 * The refusal for a Host's pi-hc-control that speaks another protocol than `expected` (endpoint.ts SCHEMA), or that
 * names it but answered `unknownOp` with unknown_op.
 */
export function controlProtocolSkew(expected: string, control: string, host: string, unknownOp?: string): Error & { code: string; detail: string } {
	const unknown = unknownOp !== undefined && control === expected;
	const message = unknown ? skewText.controlUnknownOp(host, control) : skewText.controlProtocol(host, control, expected);
	const detail = `pi-hc-control on ${host} speaks ${control}${unknown ? ` without the ${unknownOp} op` : ""}; this AmPi speaks ${expected}.`;
	return Object.assign(new Error(message), { code: VERSION_SKEW, detail });
}
