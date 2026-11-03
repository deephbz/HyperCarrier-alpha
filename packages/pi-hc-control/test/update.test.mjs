// Self-update guards (src/update.ts), one test each, on a real Git checkout with injected stamps and short timings.
import "./home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSelfUpdate } from "../src/update.ts";

const OLD = { id: "old000000000", order: 1, line: "stable" };
const NEW = { id: "new000000000", order: 2, line: "stable" };
const OTHER = { id: "edit00000000", order: 3, line: "stable" };
let sessions = 0;

function checkout(t) {
  const root = mkdtempSync(join(tmpdir(), "hcc-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, "src");
  mkdirSync(src);
  writeFileSync(join(src, "control.ts"), "// v1\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  return { root, src, gitDir: join(root, ".git") };
}

/** A self-update over a checkout whose disk build is `disk()`; it records reloads, notices and disk reads. */
function setup(t, { disk = () => NEW, quiet = () => true, ...options } = {}) {
  const { src, gitDir } = checkout(t);
  const id = `sess-${++sessions}`;
  const reloads = [];
  const notices = [];
  let reads = 0;
  const update = createSelfUpdate({
    loaded: OLD,
    sessionId: () => id,
    quiet,
    reload: (target) => reloads.push(target.id),
    notify: (text, level) => notices.push([level, text]),
    src,
    readDisk: () => (reads++, disk()),
    quietMs: 0,
    stableMs: 20,
    jitterMs: 0,
    ...options,
  });
  t.after(() => update.stop());
  return { update, reloads, notices, reads: () => reads, src, gitDir, id };
}

test("self-update reloads when the disk build is the expected one and not the loaded one", async (t) => {
  const { update, reloads } = setup(t);
  update.expect(NEW);
  assert.equal(await update.check(), "reloading");
  assert.deepEqual(reloads, [NEW.id]);
});

test("guard (1): without AmPi's expected build, nothing reloads", async (t) => {
  const { update, reloads } = setup(t);
  assert.equal(await update.check(), "no_expected");
  assert.deepEqual(reloads, []);
});

test("guard (1): a disk build that differs from both the expected and the loaded one does not reload", async (t) => {
  const { update, reloads } = setup(t, { disk: () => OTHER });
  update.expect(NEW);
  assert.equal(await update.check(), "no_target");
  assert.deepEqual(reloads, []);
});

test("guard (b): a Session that is not idle, or has queued input, does not reload", async (t) => {
  let quiet = false;
  const { update, reloads, reads } = setup(t, { quiet: () => quiet });
  update.expect(NEW);
  assert.equal(await update.check(), "not_quiet");
  assert.deepEqual(reloads, []);
  assert.equal(reads(), 0, "a busy Session costs no disk read");
  quiet = true;
  assert.equal(await update.check(), "reloading");
});

test("guard (b): Pi turning busy during the stability wait cancels the reload", async (t) => {
  let calls = 0;
  const { update, reloads } = setup(t, { quiet: () => ++calls === 1 });
  update.expect(NEW);
  assert.equal(await update.check(), "not_quiet");
  assert.deepEqual(reloads, []);
});

test("guard (P2): the quiet window runs from the last owner input or agent event", async (t) => {
  let clock = 1_000_000;
  const { update, reloads, reads } = setup(t, { quietMs: 30_000, now: () => clock });
  update.expect(NEW);
  update.activity();
  clock += 29_000;
  assert.equal(await update.check(), "not_quiet");
  assert.equal(reads(), 0, "inside the window, no disk read");
  clock += 1_000;
  assert.equal(await update.check(), "reloading");
  assert.deepEqual(reloads, [NEW.id]);
});

test("guard (c): a Git operation in progress defers the reload", async (t) => {
  const { update, reloads, gitDir } = setup(t);
  update.expect(NEW);
  for (const name of ["index.lock", "rebase-merge"]) {
    const path = join(gitDir, name);
    name.endsWith(".lock") ? writeFileSync(path, "") : mkdirSync(path);
    assert.equal(await update.check(), "checkout_busy", name);
    rmSync(path, { recursive: true });
  }
  assert.deepEqual(reloads, []);
  assert.equal(await update.check(), "reloading");
});

test("guard (c): two disk reads that disagree defer the reload", async (t) => {
  let n = 0;
  const { update, reloads } = setup(t, { disk: () => (++n === 1 ? NEW : OTHER) });
  update.expect(NEW);
  assert.equal(await update.check(), "unstable");
  assert.deepEqual(reloads, []);
});

test("guard (d): one try per Session and build; a reload that did not take reports once and stops", async (t) => {
  const { update, reloads, notices, id } = setup(t);
  update.expect(NEW);
  assert.equal(await update.check(), "reloading");
  assert.equal(await update.check(), "tried");
  assert.deepEqual(reloads, [NEW.id]);
  // The reloaded module: same process and Session, still the old build (a partial pull).
  const after = createSelfUpdate({ loaded: OLD, sessionId: () => id, quiet: () => true, reload: (s) => reloads.push(s.id), notify: (text, level) => notices.push([level, text]), quietMs: 0, stableMs: 20, jitterMs: 0, readDisk: () => NEW });
  t.after(() => after.stop());
  after.started();
  after.started();
  assert.deepEqual(notices, [["warning", `HC control reloaded but still runs ${OLD.id}, not ${NEW.id}. Restart this Pi Session.`]]);
  after.expect(NEW);
  assert.equal(await after.check(), "tried");
  assert.deepEqual(reloads, [NEW.id]);
});

test("notice (P3): the reloaded control says which build it runs, once", async (t) => {
  const { update, id } = setup(t);
  update.expect(NEW);
  assert.equal(await update.check(), "reloading");
  const notices = [];
  const after = createSelfUpdate({ loaded: NEW, sessionId: () => id, quiet: () => true, reload() {}, notify: (text, level) => notices.push([level, text]), readDisk: () => NEW });
  t.after(() => after.stop());
  after.started();
  after.started();
  assert.deepEqual(notices, [["info", `HC control updated to ${NEW.id}; extensions reloaded`]]);
});

test("guard (e): an unchanged tree is not hashed again; a changed file is", async (t) => {
  const { update, reads, src } = setup(t, { disk: () => OTHER });
  update.expect(NEW);
  await update.check();
  await update.check();
  assert.equal(reads(), 1, "the second check only stats");
  utimesSync(join(src, "control.ts"), new Date(), new Date(Date.now() + 5_000));
  await update.check();
  assert.equal(reads(), 2);
});

test("guard (f): a status-triggered check waits a random 0 to jitterMs", async (t) => {
  const { update, reloads } = setup(t, { jitterMs: 300, random: () => 0.5 });
  const started = Date.now();
  update.expect(NEW);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(reloads, [], "no reload before the jitter");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(reloads, [NEW.id]);
  assert.ok(Date.now() - started >= 150);
});
