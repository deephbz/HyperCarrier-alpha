#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const repo = path.resolve(root, "../..");
function git(args) {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	if (result.status !== 0) throw new Error((result.stderr || result.error?.message || "git failed").trim());
	return result.stdout.trimEnd();
}

(async () => {
try {
	// The submodules AmPi loads: derived from the package graph and relative imports (scripts/submodules.mjs).
	const { scope: dependencies } = (await import("./submodules.mjs")).ampiSubmodules(repo);
	// The guarded fix: plain `git -C <submodule>` on an uninitialized directory acts on this checkout.
	const fix = (submodule) => `node apps/ampi/scripts/submodules.mjs pin ${submodule}`;
	const status = git(["submodule", "status", "--", ...dependencies]);
	let failed = false;
	for (const line of status.split("\n").filter(Boolean)) {
		const match = line.match(/^([ +-U])([0-9a-f]+)\s+(\S+)/);
		if (!match) throw new Error(`cannot parse git submodule status: ${line}`);
		const [, state, actual, submodule] = match;
		if (!dependencies.includes(submodule)) continue;
		const pinned = git(["ls-tree", "HEAD", submodule]).match(/^160000 commit ([0-9a-f]+)\s/)?.[1];
		if (!pinned) throw new Error(`HEAD has no ${submodule} gitlink`);
		if (state === "-") {
			console.error(`AmPi tests need ${submodule} at ${pinned}; fix: ${fix(submodule)}`);
			failed = true;
		} else if (state === "+" || state === "U" || actual !== pinned) {
			console.error(`AmPi tests need ${submodule} at ${pinned} (found ${actual}); fix: ${fix(submodule)}`);
			failed = true;
		}
	}
	if (failed) {
		process.exitCode = 1;
		return;
	}
	try {
		const packageDir = path.dirname(path.dirname(require.resolve("node-pty")));
		const helper = path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
		if (fs.existsSync(helper) && (fs.statSync(helper).mode & 0o111) === 0) fs.chmodSync(helper, 0o755);
	} catch {
		// node-pty is optional; its platform support is checked by terminal tests.
	}
} catch (error) {
	console.error(`AmPi test preflight failed: ${error.message}`);
	process.exitCode = 1;
}
})();
