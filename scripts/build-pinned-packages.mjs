#!/usr/bin/env node
// Builds each pinned package checkout that ships `dist`, dependencies first, and stamps `dist` with the commit it
// was built from. AmPi's node build (apps/ampi/src/shared/build.ts) refuses a dist whose stamp is not the pinned
// gitlink, so a pin bump without a rebuild fails by name. Root `prepare` runs this after `npm ci` and `npm install`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
let rows;
try {
	rows = git("ls-files", "-s", "--", "packages");
} catch {
	process.exit(0); // Not a git checkout: a registry install ships dist and pins nothing.
}
const packages = new Map();
for (const row of rows.split("\n")) {
	const [mode, , , path] = row.split(/\s+/);
	if (mode !== "160000" || !existsSync(join(root, path, "package.json"))) continue;
	const json = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
	if (json.scripts?.build && JSON.stringify(json.exports ?? {}).includes("./dist/")) packages.set(json.name, { path, json });
}
const done = new Set();
const build = (name) => {
	if (done.has(name)) return;
	done.add(name);
	const { path, json } = packages.get(name);
	for (const dependency of Object.keys(json.dependencies ?? {})) if (packages.has(dependency)) build(dependency);
	execFileSync("npm", ["run", "build", "--silent"], { cwd: join(root, path), stdio: "inherit" });
	writeFileSync(join(root, path, "dist/.source-commit"), `${git("-C", path, "rev-parse", "HEAD").trim()}\n`);
};
for (const name of [...packages.keys()].sort()) build(name);
