import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUILD_STAMP, lockResolve, nodeBuild, sameBuild, StalePackageBuild, UNKNOWN_BUILD } from "../src/shared/build.ts";
import { SIM, startNode } from "./crash-fixtures.ts";

const APP = fileURLToPath(new URL("../", import.meta.url));
const REPO = resolve(APP, "../..");
const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A checkout copy with the node inputs, the lock, the workspace links and some hub, web and docs files. */
function checkout(): string {
	const dir = mkdtempSync(join(tmpdir(), "ampi-build-"));
	temps.push(dir);
	const copy = (rel: string) => {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		cpSync(join(REPO, rel), join(dir, rel));
	};
	for (const rel of nodeBuild().files) copy(rel);
	for (const rel of HUB_SIDE) copy(rel);
	copy("package-lock.json");
	mkdirSync(join(dir, "node_modules/@hypercarrier"), { recursive: true });
	for (const name of readdirSync(join(REPO, "node_modules/@hypercarrier"))) {
		const link = join(REPO, "node_modules/@hypercarrier", name);
		if (!lstatSync(link).isSymbolicLink()) continue;
		// npm may write a workspace link as an absolute path; the copy's link targets the copy's package.
		const target = resolve(dirname(link), readlinkSync(link));
		symlinkSync(target.startsWith(`${REPO}/`) ? join(dir, target.slice(REPO.length + 1)) : target, join(dir, "node_modules/@hypercarrier", name));
		const pkg = join(target, "package.json");
		if (existsSync(pkg)) copy(pkg.slice(REPO.length + 1));
	}
	return dir;
}

/** Files `ampi node` does not load: the hub-side commands, the hub, the web app, the docs. */
const HUB_SIDE = ["apps/ampi/src/commands.ts", "apps/ampi/src/doctor.ts", "apps/ampi/src/hub/hub.ts", "apps/ampi/web/src/main.tsx", "apps/ampi/docs/pi-backend.md"];

const edit = (dir: string, rel: string, change: (text: string) => string) => writeFileSync(join(dir, rel), change(readFileSync(join(dir, rel), "utf8")));

test("the node build covers the node's code, plugins, assets and packages, and no hub or web code", () => {
	const build = nodeBuild();
	assert.match(build.id, /^n1-[0-9a-f]{12}$/);
	assert.deepEqual(build.missing, []);
	for (const file of ["apps/ampi/bin/ampi.mjs", "apps/ampi/src/node/runtime.ts", "apps/ampi/src/node/server.ts", "apps/ampi/src/shared/protocol.ts", "apps/ampi/src/plugins/rarebit.ts", "packages/pi-team-durable/dist/authority/index.js", "packages/pi-team-durable/dist/authority/rc7-contract.json"])
		assert.ok(build.files.includes(file), `${file} is a node input`);
	assert.ok(build.files.includes("apps/ampi/src/cli.ts"), "the command dispatch is a node input");
	assert.deepEqual(build.files.filter((file) => /^apps\/ampi\/(src\/(hub|pi)\/|src\/(commands|doctor|trace|loop-watch)\.ts|web\/|docs\/)/.test(file)), []);
	assert.ok(build.packages.some((entry) => entry.startsWith("@earendil-works/pi-durable@")));
});

test("a moved checkout gives an equal node build", () => {
	const a = nodeBuild(checkout()).id;
	assert.equal(nodeBuild(checkout()).id, a);
	assert.equal(a, nodeBuild().id);
});

test("hub-side command, hub, web and docs edits keep the node build", () => {
	const dir = checkout();
	const before = nodeBuild(dir).id;
	for (const rel of HUB_SIDE) edit(dir, rel, (text) => `${text}\n// edited\n`);
	assert.equal(nodeBuild(dir).id, before);
});

test("an edit to a node input changes the node build", () => {
	const inputs: [string, (text: string) => string][] = [
		["apps/ampi/src/node/runtime.ts", (text) => `${text}\n`],
		["apps/ampi/src/shared/protocol.ts", (text) => `${text}\n`],
		["apps/ampi/src/plugins/rarebit.ts", (text) => `${text}\n`],
		["packages/pi-team-durable/dist/authority/rc7-contract.json", (text) => `${text} `],
		["packages/pi-team-durable/dist/authority/index.js", (text) => `${text}\n`],
		["package-lock.json", (text) => text.replace(/("node_modules\/@earendil-works\/pi-durable": \{\s*"version": ")[^"]+/, "$1 9.9.9")],
	];
	for (const [rel, change] of inputs) {
		const dir = checkout();
		const before = nodeBuild(dir).id;
		edit(dir, rel, change);
		assert.notEqual(nodeBuild(dir).id, before, `an edit to ${rel} changes the build`);
	}
});

test("a missing input gives an unknown build, and an unknown, absent or old-algorithm build never matches", () => {
	const dir = checkout();
	rmSync(join(dir, "apps/ampi/src/shared/framing.ts"));
	const build = nodeBuild(dir);
	assert.equal(build.id, UNKNOWN_BUILD);
	assert.deepEqual(build.missing, ["apps/ampi/src/shared/framing.ts"]);
	assert.equal(sameBuild(UNKNOWN_BUILD, UNKNOWN_BUILD), false);
	assert.equal(sameBuild(undefined, "n1-000000000000"), false);
	assert.equal(sameBuild("0123456789ab", "n1-000000000000"), false);
	assert.equal(sameBuild("n1-000000000000", "n1-000000000000"), true);
});

test("a pinned package without its built dist gives an unknown build", () => {
	const dir = checkout();
	rmSync(join(dir, "packages/pi-team-durable/dist"), { recursive: true, force: true });
	const build = nodeBuild(dir);
	assert.equal(build.id, UNKNOWN_BUILD);
	assert.ok(build.missing.includes("packages/pi-team-durable/dist/authority/index.js"), build.missing.join(", "));
});

test("a pinned package whose dist stamp names another commit fails by name", () => {
	const dir = checkout();
	const pinned = "1".repeat(40);
	const stamp = join(dir, "packages/pi-team-durable", BUILD_STAMP);
	execFileSync("git", ["init", "-q", dir]);
	execFileSync("git", ["-C", dir, "update-index", "--add", "--cacheinfo", `160000,${pinned},packages/pi-team-durable`]);
	writeFileSync(stamp, `${"2".repeat(40)}\n`);
	assert.throws(() => nodeBuild(dir), (error: Error) => error instanceof StalePackageBuild && error.message.includes(pinned));
	rmSync(stamp);
	assert.throws(() => nodeBuild(dir), StalePackageBuild, "an unstamped dist is stale");
	writeFileSync(stamp, `${pinned}\n`);
	assert.match(nodeBuild(dir).id, /^n1-/);
});

/** Rewrites one lock entry of a checkout. */
function editLock(dir: string, change: (packages: Record<string, Record<string, unknown>>) => void): void {
	const path = join(dir, "package-lock.json");
	const lock = JSON.parse(readFileSync(path, "utf8")) as { packages: Record<string, Record<string, unknown>> };
	change(lock.packages);
	writeFileSync(path, JSON.stringify(lock));
}
const DURABLE = "node_modules/@earendil-works/pi-durable";

test("a package resolves by npm's node_modules walk-up: nested first, then each parent, then the root", () => {
	const lock = { "node_modules/a": {}, "node_modules/a/node_modules/b": {}, "node_modules/a/node_modules/c": {}, "node_modules/c": {}, "node_modules/d": {}, "apps/x/node_modules/d": {} };
	assert.equal(lockResolve(lock, "c", "node_modules/a/node_modules/b"), "node_modules/a/node_modules/c", "a parent's copy wins over the root's");
	assert.equal(lockResolve(lock, "b", "node_modules/a"), "node_modules/a/node_modules/b", "a nested copy wins");
	assert.equal(lockResolve(lock, "d", "node_modules/a/node_modules/b"), "node_modules/d");
	assert.equal(lockResolve(lock, "d", "apps/x/src/node"), "apps/x/node_modules/d", "a workspace's own copy wins for its files");
	assert.equal(lockResolve(lock, "e", "node_modules/a"), undefined);
	// The real lock: the app's own ws is not the root's.
	const real = (JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8")) as { packages: Record<string, unknown> }).packages;
	if (real["apps/ampi/node_modules/ws"]) assert.equal(lockResolve(real, "ws", "apps/ampi/src/node"), "apps/ampi/node_modules/ws");
});

test("a nested lock copy, an optional dependency and a peer dependency are node inputs", () => {
	const cases: [string, (packages: Record<string, Record<string, unknown>>) => void][] = [
		["nested copy", (p) => void (p[`${DURABLE}/node_modules/diff`] = { ...p["node_modules/diff"], version: "0.0.1-nested" })],
		["optional dependency", (p) => void (p[DURABLE]!.optionalDependencies = { "fast-check": "*" })],
		["peer dependency", (p) => void (p[DURABLE]!.peerDependencies = { "fast-check": "*" })],
	];
	for (const [label, change] of cases) {
		const dir = checkout();
		const before = nodeBuild(dir).id;
		editLock(dir, change);
		const after = nodeBuild(dir);
		assert.match(after.id, /^n1-/, label);
		assert.notEqual(after.id, before, `a ${label} changes the build`);
	}
});

test("a missing optional dependency is allowed; any other missing lock entry gives an unknown build", () => {
	const allowed: [string, (packages: Record<string, Record<string, unknown>>) => void][] = [
		["optional dependency", (p) => void (p[DURABLE]!.optionalDependencies = { "no-such-optional": "*" })],
		["optional peer dependency", (p) => void Object.assign(p[DURABLE]!, { peerDependencies: { "no-such-peer": "*" }, peerDependenciesMeta: { "no-such-peer": { optional: true } } })],
	];
	for (const [label, change] of allowed) {
		const dir = checkout();
		const before = nodeBuild(dir).id;
		editLock(dir, change);
		assert.equal(nodeBuild(dir).id, before, `a missing ${label} keeps the build`);
	}
	const refused: [string, (packages: Record<string, Record<string, unknown>>) => void, string][] = [
		["dependency", (p) => void (p[DURABLE]!.dependencies = { ...(p[DURABLE]!.dependencies as object), "no-such-dependency": "*" }), `${DURABLE} > no-such-dependency`],
		["peer dependency", (p) => void (p[DURABLE]!.peerDependencies = { "no-such-peer": "*" }), `${DURABLE} > no-such-peer`],
		["package", (p) => void delete p[DURABLE], "> @earendil-works/pi-durable"],
	];
	for (const [label, change, entry] of refused) {
		const dir = checkout();
		editLock(dir, change);
		const build = nodeBuild(dir);
		assert.equal(build.id, UNKNOWN_BUILD, `a missing ${label} gives unknown`);
		assert.ok(build.missing.some((m) => m.startsWith("package-lock.json: ") && m.endsWith(entry)), `${label}: ${build.missing.join(", ")}`);
	}
});

test("every repo module the real `ampi node` loads is a node input", async () => {
	const home = mkdtempSync(join(tmpdir(), "ampi-build-node-"));
	temps.push(home);
	// The launcher, run as the supervisor runs it, with a hook that records every file module it resolves.
	const hook = join(home, "record.mjs");
	writeFileSync(
		hook,
		`import { registerHooks } from "node:module";
		import { writeFileSync } from "node:fs";
		const loaded = new Set();
		registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); if (result.url.startsWith("file:")) loaded.add(result.url); return result; } });
		process.on("exit", () => writeFileSync(${JSON.stringify(join(home, "loaded.json"))}, JSON.stringify([...loaded])));`,
	);
	const { child, client } = await startNode(home, 50000, { NODE_OPTIONS: `--import ${pathToFileURL(hook).href}` });
	try {
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Name one risk" });
		await client.until(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.contextTokens, 10_000);
	} finally {
		client.close();
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.kill("SIGTERM");
		await exited;
	}
	const loaded = (JSON.parse(readFileSync(join(home, "loaded.json"), "utf8")) as string[]).map((href) => fileURLToPath(href)).filter((path) => path.startsWith(`${REPO}/`) && !path.includes("/node_modules/"));
	const inputs = new Set(nodeBuild().files);
	const outside = loaded.map((path) => path.slice(REPO.length + 1)).filter((rel) => !inputs.has(rel));
	assert.deepEqual(outside, [], "modules the node loads that the node build does not hash");
	for (const file of ["/bin/ampi.mjs", "/src/cli.ts", "/src/node/runtime.ts", "/src/plugins.ts"]) assert.ok(loaded.some((path) => path.endsWith(`/apps/ampi${file}`)), `the node loaded ${file}`);
});
