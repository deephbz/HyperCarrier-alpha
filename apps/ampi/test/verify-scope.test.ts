import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// The scripts are untyped .mjs; a URL specifier keeps them out of the TypeScript project.
type Pinned = { ok: boolean; detail: string; warnings: string[] };
const { ampiSubmodules } = (await import(new URL("../scripts/submodules.mjs", import.meta.url).href)) as { ampiSubmodules(root: string): { scope: string[]; reasons: Record<string, string>; other: string[] } };
const { submodulesPinned } = (await import(new URL("../scripts/verify/hub.mjs", import.meta.url).href)) as { submodulesPinned(root: string): Pinned };
const { submoduleGit } = (await import(new URL("../scripts/submodules.mjs", import.meta.url).href)) as { submoduleGit(root: string, path: string, args: string[]): string };

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (file: string, text: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
};
function repo(dir: string, files: Record<string, string>) {
	for (const [name, text] of Object.entries(files)) write(join(dir, name), text);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

/** A workspace with three submodules: one AmPi depends on, one it imports by relative path, and one it never loads. */
function fixture() {
	const base = mkdtempSync(join(tmpdir(), "ampi-verify-scope-"));
	const sources = {
		inscope: repo(join(base, "src-inscope"), { "package.json": '{"name":"@x/inscope"}', "index.ts": "export {};\n" }),
		relsub: repo(join(base, "src-relsub"), { "package.json": '{"name":"relsub"}', "index.ts": "export {};\n" }),
		other: repo(join(base, "src-other"), { "package.json": '{"name":"@x/other"}', "index.ts": "export {};\n" }),
	};
	const root = repo(join(base, "root"), {
		"package.json": '{"workspaces":["apps/*","packages/*","!apps/relsub"]}',
		"apps/ampi/package.json": '{"name":"@x/ampi","dependencies":{"@x/inscope":"*"}}',
		"apps/ampi/src/search.ts": 'export { x } from "../../relsub/index.ts";\n',
	});
	for (const [path, source] of [["packages/inscope", sources.inscope], ["apps/relsub", sources.relsub], ["packages/other", sources.other]]) git(root, "submodule", "add", "-q", source, path);
	git(root, "commit", "-q", "-m", "submodules");
	return { base, root };
}

test("AmPi submodule scope comes from the package graph and relative imports", () => {
	const { base, root } = fixture();
	try {
		const { scope, reasons, other } = ampiSubmodules(root);
		assert.deepEqual(scope, ["packages/inscope", "apps/relsub"]);
		assert.deepEqual(other, ["packages/other"]);
		assert.match(reasons["packages/inscope"], /depends on @x\/inscope/);
		assert.match(reasons["apps/relsub"], /imports \.\.\/\.\.\/relsub/);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("drift in an unrelated submodule warns; drift in an AmPi submodule fails", () => {
	const { base, root } = fixture();
	try {
		assert.deepEqual(submodulesPinned(root), { ok: true, detail: "2 AmPi submodules (packages/inscope, apps/relsub) at their gitlink SHAs with clean tracked files", warnings: [] });

		write(join(root, "packages/other/index.ts"), "export const drift = 1;\n");
		git(join(root, "packages/other"), "commit", "-q", "-am", "drift");
		const unrelated = submodulesPinned(root);
		assert.equal(unrelated.ok, true);
		assert.equal(unrelated.warnings.length, 1);
		assert.match(unrelated.warnings[0], /^packages\/other at [0-9a-f]{12}, pinned [0-9a-f]{12} \(AmPi does not load it; ignored\)$/);

		write(join(root, "packages/inscope/index.ts"), "export const drift = 1;\n");
		const tracked = submodulesPinned(root);
		assert.equal(tracked.ok, false);
		assert.match(tracked.detail, /^packages\/inscope at 1 tracked files changed/);
		assert.match(tracked.detail, /run\.mjs --checkout [0-9a-f]+$/);

		git(join(root, "packages/inscope"), "checkout", "-q", "--", ".");
		rmSync(join(root, "apps/relsub"), { recursive: true, force: true });
		mkdirSync(join(root, "apps/relsub"));
		const missing = submodulesPinned(root);
		assert.equal(missing.ok, false);
		assert.match(missing.detail, /^apps\/relsub at not checked out/);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

/** A second worktree with the submodule directory but no repository in it, only ignored files (as after npm ci). */
function bareSubmoduleTree() {
	const { base, root } = fixture();
	const tree = join(base, "tree");
	git(root, "worktree", "add", "-q", "--detach", tree);
	write(join(tree, "packages/inscope/node_modules/dep/index.js"), "\n");
	return { base, tree, head: git(tree, "rev-parse", "HEAD").trim() };
}

test("the printed fix for an uninitialized submodule pins it and never moves the parent checkout", () => {
	const { base, tree, head } = bareSubmoduleTree();
	try {
		const missing = submodulesPinned(tree);
		assert.equal(missing.ok, false);
		const fix = missing.detail.match(/^packages\/inscope at not checked out, pinned [0-9a-f]{12}\. Fix: (.+)$/m)?.[1];
		assert.ok(fix, missing.detail);
		try { execFileSync("sh", ["-c", fix], { cwd: tree, stdio: "ignore" }); } catch {}
		assert.equal(git(tree, "rev-parse", "HEAD").trim(), head, "the fix moved the parent worktree's HEAD");
		assert.doesNotMatch(submodulesPinned(tree).detail, /^packages\/inscope/m);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("git on a submodule path refuses a directory that is not its own repository", () => {
	const { base, tree, head } = bareSubmoduleTree();
	try {
		assert.throws(() => submoduleGit(tree, "packages/inscope", ["checkout", "--detach", "HEAD~1"]), /not a checked-out repository; refusing git checkout/);
		assert.equal(git(tree, "rev-parse", "HEAD").trim(), head);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
