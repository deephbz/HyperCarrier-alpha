// Acceptance for self-update in a real Pi: the installed `pi` in RPC mode, Pi's own loader, and
// the package loaded from settings.json the way the owner's Pi loads it. The sim test
// (reload.sim.test.mjs) proves the in-process reload path; this one proves the real carrier.
import "./home.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { request } from "../src/client.ts";
import { readDescriptor } from "../src/endpoint.ts";
import { controlStamp } from "../src/stamp.ts";

const PI = process.env.HC_PI_BIN ?? "pi";
const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const available = spawnSync(PI, ["--version"], { encoding: "utf8" }).status === 0;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });

/** A git checkout of this package, so its stamp is real and a commit changes it. */
function checkout(root) {
  const dir = join(root, "pkg");
  mkdirSync(dir);
  cpSync(join(PACKAGE, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(PACKAGE, "package.json"), join(dir, "package.json"));
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "old");
  return dir;
}

function rpc(root, agentDir) {
  const child = spawn(PI, ["--mode", "rpc", "--offline", "--no-session", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes"], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let buffer = "";
  let seq = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    appendFileSync(join(root, "rpc.jsonl"), text);
    buffer += text;
    for (let lf; (lf = buffer.indexOf("\n")) !== -1; ) {
      const line = buffer.slice(0, lf);
      buffer = buffer.slice(lf + 1);
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.type === "response" && pending.has(record.id)) {
        pending.get(record.id)(record);
        pending.delete(record.id);
      }
    }
  });
  child.stderr.on("data", (text) => appendFileSync(join(root, "stderr.txt"), text));
  return {
    command(frame) {
      const id = `t-${++seq}`;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ ...frame, id })}\n`);
      });
    },
    close: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => (clearTimeout(timer), resolve()));
        child.stdin.end();
      }),
  };
}

/** The first live status whose reply satisfies `accept`, or null at the deadline. */
async function liveStatus(dir, accept, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    for (const name of (() => { try { return readdirSync(dir); } catch { return []; } })()) {
      if (!name.endsWith(".json")) continue;
      const descriptor = readDescriptor(join(dir, name));
      if (!descriptor?.socket) continue;
      try {
        const reply = await request(descriptor.socket, { op: "status" }, { timeoutMs: 1_000 });
        if (reply.ok && accept(reply.value)) return reply.value;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

test("a real Pi runs pulled control code after /hc-control-reload, under a new nonce", { skip: !available && `no ${PI}`, timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hc-reload-rpc-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const pkg = checkout(root);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
  const pi = rpc(root, agentDir);
  try {
    const dir = join(agentDir, "hc-control");
    const before = await liveStatus(dir, () => true, 30_000);
    assert.ok(before?.stamp?.id, `the control serves status with a stamp; stderr: ${(() => { try { return readFileSync(join(root, "stderr.txt"), "utf8"); } catch { return ""; } })()}`);

    // A pull: new source on disk and a new HEAD.
    appendFileSync(join(pkg, "src", "control.ts"), "\n// pulled\n");
    git(pkg, "commit", "-q", "-am", "new");

    const reply = await pi.command({ type: "prompt", message: "/hc-control-reload" });
    assert.equal(reply.success, true, JSON.stringify(reply));
    const started = Date.now();
    const after = await liveStatus(dir, (status) => status.nonce !== before.nonce, 30_000);
    assert.ok(after, "a new endpoint answers after the reload");
    assert.notEqual(after.stamp.id, before.stamp.id, "status names the pulled build");
    console.log(`reload gap ${Date.now() - started} ms`);
  } finally {
    await pi.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real idle Pi updates itself when AmPi expects the pulled build, and the model sees nothing", { skip: !available && `no ${PI}`, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hc-update-rpc-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const pkg = checkout(root);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
  const pi = rpc(root, agentDir);
  try {
    const dir = join(agentDir, "hc-control");
    const before = await liveStatus(dir, () => true, 30_000);
    assert.ok(before?.stamp?.id, "the control serves status with a stamp");

    appendFileSync(join(pkg, "src", "control.ts"), "\n// pulled\n");
    git(pkg, "commit", "-q", "-am", "new");
    const expected = controlStamp(join(pkg, "src"));
    assert.notEqual(expected.id, before.stamp.id);

    // AmPi's probe: a status op that names the build the hub expects. Nothing else happens in this Pi.
    const descriptor = readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => readDescriptor(join(dir, name))).find((d) => d?.socket);
    const reply = await request(descriptor.socket, { op: "status", expect: expected }, { timeoutMs: 1_000 });
    assert.equal(reply.ok, true);
    // Quiet window (30 s from load) + jitter (at most 5 s) + stability wait (2 s).
    const after = await liveStatus(dir, (status) => status.nonce !== before.nonce, 60_000);
    assert.ok(after, `a new endpoint answers after the self-update; stderr: ${(() => { try { return readFileSync(join(root, "stderr.txt"), "utf8"); } catch { return ""; } })()}`);
    assert.equal(after.stamp.id, expected.id, "status names the pulled build");

    const records = readFileSync(join(root, "rpc.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const notices = records.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => r.message);
    assert.ok(notices.includes(`HC control updated to ${expected.id}; extensions reloaded`), JSON.stringify(notices));
    const messages = (await pi.command({ type: "get_messages" })).data.messages;
    assert.deepEqual(messages, [], "the reload command never reaches the model or the history");
  } finally {
    await pi.close();
    rmSync(root, { recursive: true, force: true });
  }
});
