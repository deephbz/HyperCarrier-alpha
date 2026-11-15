#!/usr/bin/env node
// Builds each pinned package checkout that ships `dist`, dependencies first, and stamps `dist` with the commit it
// was built from. AmPi's node build (apps/ampi/src/shared/build.ts) refuses a dist whose stamp is not the pinned
// gitlink, so a pin bump without a rebuild fails by name. Root `prepare` runs this after `npm ci` and `npm install`.
//
// The builds are cached by key: a hash of the package gitlinks, package-lock.json and this script. A key that
// built once is recorded with a copy of every dist, in `<git common dir>/hc-prepare/<key>` (HC_PREPARE_CACHE moves
// it), so every worktree of the checkout shares it. A recorded dist carries the key in `dist/.prepare-key`. On a hit,
// a dist with the key and a stamp that names its gitlink stays; another one is restored from the copy. The run builds as before when a stamp still differs afterwards, when a
// package checkout is not at its gitlink or has local changes, or when HC_PREPARE_FORCE=1. A failed build records
// no key.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Alpha exports this file without scripts/lib/stdio-sync.mjs, so it carries that line inline.
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);

const STAMP = "dist/.source-commit";
const KEY = "dist/.prepare-key"; // a dist built from a local change has none, so a hit never keeps it
const KEEP = 4; // cached keys kept; a rollback to one of the last few pins restores without a build
const root = new URL("..", import.meta.url).pathname;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
let rows;
try {
	rows = git("ls-files", "-s", "--", "packages");
} catch {
	process.exit(0); // Not a git checkout: a registry install ships dist and pins nothing.
}
const packages = new Map();
const gitlinks = [];
for (const row of rows.split("\n")) {
	const [mode, sha, , path] = row.split(/\s+/);
	if (mode !== "160000") continue;
	gitlinks.push(`${sha} ${path}`);
	if (!existsSync(join(root, path, "package.json"))) continue;
	const json = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
	if (json.scripts?.build && JSON.stringify(json.exports ?? {}).includes("./dist/")) packages.set(json.name, { path, json, pin: sha });
}

const read = (path, file) => {
	try {
		return readFileSync(join(root, path, file), "utf8").trim();
	} catch {
		return undefined;
	}
};
// A package checkout the key can stand for: at its gitlink, with no local changes. Anything else builds.
const pristine = ({ path, pin }) => {
	try {
		return git("-C", path, "rev-parse", "HEAD").trim() === pin && git("-C", path, "status", "--porcelain", "--untracked-files=no").trim() === "";
	} catch {
		return false;
	}
};
const lock = join(root, "package-lock.json");
const key = createHash("sha256")
	.update(gitlinks.join("\n"))
	.update("\0")
	.update(existsSync(lock) ? readFileSync(lock) : "no lock")
	.update("\0")
	.update(readFileSync(new URL(import.meta.url)))
	.digest("hex")
	.slice(0, 24);
const cacheDir = process.env.HC_PREPARE_CACHE || resolve(root, git("rev-parse", "--git-common-dir").trim(), "hc-prepare");
const entry = join(cacheDir, key);
const all = [...packages.values()];
const stamped = (p) => read(p.path, STAMP) === p.pin;
const kept = (p) => stamped(p) && read(p.path, KEY) === key;

if (process.env.HC_PREPARE_FORCE !== "1" && all.every(pristine) && existsSync(join(entry, "key"))) {
	for (const p of all) {
		if (kept(p)) continue;
		const saved = join(entry, p.path, "dist");
		if (!existsSync(saved)) continue;
		rmSync(join(root, p.path, "dist"), { recursive: true, force: true });
		cpSync(saved, join(root, p.path, "dist"), { recursive: true });
	}
	if (all.every(kept)) {
		console.log(`root prepare: cached build ${key}; ${all.length} pinned package dists match their gitlinks (HC_PREPARE_FORCE=1 rebuilds)`);
		process.exit(0);
	}
}

const done = new Set();
const build = (name) => {
	if (done.has(name)) return;
	done.add(name);
	const { path, json } = packages.get(name);
	for (const dependency of Object.keys(json.dependencies ?? {})) if (packages.has(dependency)) build(dependency);
	execFileSync("npm", ["run", "build", "--silent"], { cwd: join(root, path), stdio: "inherit" });
	writeFileSync(join(root, path, STAMP), `${git("-C", path, "rev-parse", "HEAD").trim()}\n`);
	rmSync(join(root, path, KEY), { force: true });
};
for (const name of [...packages.keys()].sort()) build(name);

// Record the key only for a build the key stands for. The copy goes to a temporary name first, so a concurrent
// run never reads half an entry.
if (all.every(pristine) && all.every(stamped)) {
	try {
		for (const p of all) writeFileSync(join(root, p.path, KEY), `${key}\n`);
		const tmp = `${entry}.tmp-${process.pid}`;
		rmSync(tmp, { recursive: true, force: true });
		for (const p of all) {
			mkdirSync(dirname(join(tmp, p.path, "dist")), { recursive: true });
			cpSync(join(root, p.path, "dist"), join(tmp, p.path, "dist"), { recursive: true });
		}
		mkdirSync(tmp, { recursive: true });
		writeFileSync(join(tmp, "key"), `${gitlinks.join("\n")}\n`);
		rmSync(entry, { recursive: true, force: true });
		renameSync(tmp, entry);
		const keys = readdirSync(cacheDir).filter((name) => /^[0-9a-f]{24}$/.test(name));
		keys.sort((a, b) => statSync(join(cacheDir, b)).mtimeMs - statSync(join(cacheDir, a)).mtimeMs);
		for (const old of keys.slice(KEEP)) rmSync(join(cacheDir, old), { recursive: true, force: true });
	} catch (error) {
		console.warn(`root prepare: built, but could not record cache ${key}: ${error.message}`);
	}
}
