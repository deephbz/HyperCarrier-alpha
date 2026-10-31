import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("../scripts/pin-guard.mjs", import.meta.url));
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", ...args], {
		cwd, encoding: "utf8", env: { ...process.env, ...identity }, stdio: ["ignore", "pipe", "pipe"],
	}).trim();
const head = (dir: string) => git(dir, "rev-parse", "HEAD");
function commitFile(dir: string, file: string, text = file) {
	mkdirSync(dirname(join(dir, file)), { recursive: true });
	writeFileSync(join(dir, file), text);
	git(dir, "add", file);
	git(dir, "commit", "-qm", file);
	return head(dir);
}
function run(root: string, target: string, base: string, env: Record<string, string> = {}, script = guard) {
	const started = Date.now();
	const r = spawnSync(process.execPath, [script, "--root", root, "--base", base, target], { encoding: "utf8", env: { ...process.env, ...env } });
	return { status: r.status, out: r.stdout + r.stderr, ms: Date.now() - started };
}

const ENTRY = "apps/ampi/scripts/deploy-live.sh";
let dir = "";
const f = {} as Record<"root" | "origin" | "a0" | "a" | "a1" | "b" | "stale" | "good" | "bad" | "ff" | "rewind" | "declared", string>;
/** Pin lib at <pin> on top of <from> with <message>; returns the superproject commit. */
function pinAt(from: string, pin: string, message: string) {
	git(f.root, "checkout", "-q", "--detach", from);
	git(join(f.root, "lib"), "checkout", "-q", "--detach", pin);
	git(f.root, "add", "lib");
	git(f.root, "commit", "-qm", message);
	return head(f.root);
}
// lib origin: a0 <- a <- a1 (a1 is pushed after the superproject's module store last fetched). b is local-only.
before(() => {
	dir = mkdtempSync(join(tmpdir(), "ampi-pin-guard-"));
	f.origin = join(dir, "lib-origin");
	f.root = join(dir, "super");
	const work = join(dir, "lib-work");
	git(dir, "init", "-q", "--bare", f.origin);
	git(dir, "clone", "-q", f.origin, work);
	f.a0 = commitFile(work, "a0");
	f.a = commitFile(work, "a");
	git(work, "push", "-q", "origin", "HEAD:main");
	git(dir, "init", "-q", f.root);
	f.stale = commitFile(f.root, ENTRY, "# an old deploy entry\n");
	writeFileSync(join(f.root, ENTRY), "export AMPI_DEPLOY_LOGIC\n");
	git(f.root, "add", ENTRY);
	git(f.root, "submodule", "add", "-q", f.origin, "lib");
	git(f.root, "commit", "-qm", "current entry; pin lib at a");
	f.good = head(f.root);
	f.b = commitFile(join(f.root, "lib"), "b");
	f.bad = pinAt(f.good, f.b, "pin a local-only lib commit");
	f.a1 = commitFile(work, "a1");
	git(work, "push", "-q", "origin", "HEAD:main");
	git(join(f.root, "lib"), "fetch", "-q", f.origin, "main");
	f.ff = pinAt(f.good, f.a1, "fast-forward lib");
	f.rewind = pinAt(f.good, f.a0, "rewind lib by accident");
	f.declared = pinAt(f.good, f.a0, `rewind lib\n\npin: lib ${f.a.slice(0, 7)}..${f.a0.slice(0, 9)} because the newer lib breaks the build`);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("pin guard reach: a gitlink on its submodule's origin passes; a local-only gitlink is refused by path and hash", () => {
	const ok = run(f.root, f.good, f.good);
	assert.equal(ok.status, 0, ok.out);
	assert.match(ok.out, /pin-guard: ok/);
	const bad = run(f.root, f.bad, f.good);
	assert.equal(bad.status, 1, bad.out);
	assert.match(bad.out, new RegExp(`REFUSED \\(reach\\): lib gitlink ${f.b} is not on its origin`));
	assert.doesNotMatch(bad.out, /REFUSED \(change\)/);
});

test("pin guard change: a rewind is refused with the declaration to add; a fast-forward or a declared change passes", () => {
	const rewind = run(f.root, f.rewind, f.good);
	assert.equal(rewind.status, 1, rewind.out);
	assert.match(rewind.out, new RegExp(`REFUSED \\(change\\): lib gitlink moves ${f.a.slice(0, 12)}\\.\\.${f.a0.slice(0, 12)}.*pin: lib ${f.a.slice(0, 12)}\\.\\.${f.a0.slice(0, 12)} because <reason>`));
	assert.doesNotMatch(rewind.out, /REFUSED \(reach\)/);
	const ff = run(f.root, f.ff, f.good);
	assert.equal(ff.status, 0, ff.out);
	const declared = run(f.root, f.declared, f.good);
	assert.equal(declared.status, 0, declared.out);
});

test("pin guard entry: a commit whose deploy entry lacks the marker is refused with 'Merge dev/ampi-int first'", () => {
	const stale = run(f.root, f.stale, f.stale);
	assert.equal(stale.status, 1, stale.out);
	assert.match(stale.out, new RegExp(`REFUSED \\(entry\\): ${f.stale.slice(0, 12)} has a stale deploy entry.*Merge dev/ampi-int first`));
});

// An unreachable or hanging origin, without touching the fixture: rewrite its URL to ssh and choose the ssh command.
const viaSsh = (command: string) => ({
	GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.ssh://pin-guard.invalid/lib.git.insteadOf", GIT_CONFIG_VALUE_0: f.origin,
	GIT_SSH_COMMAND: command, AMPI_PIN_FETCH_TIMEOUT_MS: "500",
});

test("pin guard offline: a cached pin passes without a fetch; a local-only pin warns and is refused", () => {
	const ok = run(f.root, f.good, f.good, viaSsh("false"));
	assert.equal(ok.status, 0, ok.out);
	assert.doesNotMatch(ok.out, /WARNING/);
	const bad = run(f.root, f.bad, f.good, viaSsh("false"));
	assert.equal(bad.status, 1, bad.out);
	assert.match(bad.out, /WARNING: could not fetch lib origin/);
	assert.match(bad.out, new RegExp(`REFUSED \\(reach\\): lib gitlink ${f.b} .*the fetch failed`));
});

test("pin guard offline: a hanging origin times out with a warning and a refusal, without blocking", () => {
	const r = run(f.root, f.bad, f.good, viaSsh("sleep 30 #"));
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /WARNING: could not fetch lib origin .*timed out after 500 ms/);
	assert.ok(r.ms < 5_000, `took ${r.ms} ms`);
});

test("pin guard: a copy run through a symlinked directory still checks (deploy-live.sh runs an extracted copy)", () => {
	const real = join(dir, "extract-real"), link = join(dir, "extract-link");
	mkdirSync(real);
	copyFileSync(guard, join(real, "pin-guard.mjs"));
	copyFileSync(join(dirname(guard), "stdio-sync.cjs"), join(real, "stdio-sync.cjs"));
	symlinkSync(real, link);
	const r = run(f.root, f.bad, f.good, {}, join(link, "pin-guard.mjs"));
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /REFUSED \(reach\)/);
});
