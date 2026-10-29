// Real unix sockets and files: permissions, framing, concurrent clients,
// path-length fallback, stale descriptors, Session switch, and cleanup.
import "./home.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connect, findSession, probe, request } from "../src/client.mjs";
import { MAX_SOCKET_PATH_BYTES, openEndpoint, readDescriptor, resolveAgentDir, socketPathFor } from "../src/endpoint.mjs";
import { createHcControlExtension } from "../src/extension.mjs";

const SID_A = randomUUID();
const SID_B = randomUUID();

// A test that needs the preferred socket path passes a short base; the default TMPDIR can be too long (macOS).
function scratch(t, base = tmpdir()) {
  const root = mkdtempSync(join(base, "hcc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const statusHandle = (sessionId, nonce) => async (frame) =>
  frame.op === "status"
    ? { id: frame.id, ok: true, value: { sessionId, nonce } }
    : { id: frame.id, ok: false, error: { code: "unknown_op", message: "" } };

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("agent dir follows Pi: PI_CODING_AGENT_DIR, else ~/.pi/agent", () => {
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/synthetic/agent" }), "/synthetic/agent");
  assert.ok(resolveAgentDir({}).endsWith(join(".pi", "agent")));
});

test("socket path: preferred when it fits, else a private temp directory, else a hashed name, else /tmp", () => {
  const user = `hc-ctl-${process.getuid?.() ?? "u"}`;
  const fitting = "/synthetic/agent/hc-control";
  assert.deepEqual(socketPathFor(fitting, SID_A, { tmp: "/t" }), { path: `${fitting}/${SID_A}.sock`, dir: fitting });
  const long = `/${"a".repeat(120)}/hc-control`;
  assert.deepEqual(socketPathFor(long, SID_A, { tmp: "/t" }), { path: `/t/${user}/${SID_A}.sock`, dir: `/t/${user}` });
  // The temp base fits only a hashed name.
  const tmp = `/${"b".repeat(60)}`;
  const hashed = socketPathFor(long, SID_A, { tmp });
  assert.equal(hashed.dir, `${tmp}/${user}`);
  assert.match(hashed.path, new RegExp(`^${tmp}/${user}/[0-9a-f]{16}\\.sock$`));
  assert.ok(Buffer.byteLength(hashed.path) <= MAX_SOCKET_PATH_BYTES);
  // No name fits under the temp base: /tmp is the last base.
  assert.deepEqual(socketPathFor(long, SID_A, { tmp: `/${"c".repeat(100)}` }), { path: `/tmp/${user}/${SID_A}.sock`, dir: `/tmp/${user}` });
});

test("endpoint is private, answers frames, and serves concurrent clients", async (t) => {
  const agentDir = scratch(t, "/tmp");
  assert.ok(Buffer.byteLength(join(agentDir, "hc-control", `${SID_A}.sock`)) <= MAX_SOCKET_PATH_BYTES);
  const handle = async (frame) => {
    if (frame.op === "slow") await new Promise((resolve) => setTimeout(resolve, 50));
    return { id: frame.id, ok: true, value: frame.op };
  };
  const endpoint = await openEndpoint({ agentDir, sessionId: SID_A, sessionFile: "/synthetic/a.jsonl", version: "0.1.0", handle });
  t.after(() => endpoint.close());
  assert.equal(statSync(join(agentDir, "hc-control")).mode & 0o777, 0o700);
  assert.equal(statSync(endpoint.socketPath).mode & 0o777, 0o600);
  assert.equal(statSync(endpoint.descriptorPath).mode & 0o777, 0o600);
  assert.equal(endpoint.socketPath, join(agentDir, "hc-control", `${SID_A}.sock`));
  const descriptor = readDescriptor(endpoint.descriptorPath);
  assert.deepEqual(Object.keys(descriptor).sort(), ["nonce", "pid", "schema", "sessionFile", "sessionId", "socket", "startedAt", "version"]);
  assert.equal(descriptor.sessionFile, "/synthetic/a.jsonl");

  // One connection, out-of-order replies matched by id.
  const client = await connect(endpoint.socketPath);
  const [slow, fast] = await Promise.all([client.request({ id: "s", op: "slow" }), client.request({ id: "f", op: "fast" })]);
  assert.deepEqual([slow.value, fast.value], ["slow", "fast"]);
  client.close();
  // Many connections at once.
  const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => request(endpoint.socketPath, { id: i, op: `c${i}` })));
  assert.deepEqual(replies.map((r) => r.value), Array.from({ length: 8 }, (_, i) => `c${i}`));

  // Two frames in one write, then a malformed line.
  const raw = await new Promise((resolve) => {
    const lines = [];
    const socket = net.createConnection(endpoint.socketPath, () => socket.write('{"id":1,"op":"a"}\n{"id":2,"op":"b"}\nnot json\n'));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop();
      lines.push(...parts.map((line) => JSON.parse(line)));
      if (lines.length === 3) socket.end(() => resolve(lines));
    });
  });
  assert.equal(raw.find((r) => !r.ok).error.code, "bad_request");
  assert.deepEqual(raw.filter((r) => r.ok).map((r) => r.id).sort(), [1, 2]);
});

test("close removes socket and descriptor, but not a newer owner's descriptor", async (t) => {
  const agentDir = scratch(t);
  const first = await openEndpoint({ agentDir, sessionId: SID_A, version: "0.1.0", handle: statusHandle(SID_A, "x") });
  const { socketPath, descriptorPath } = first;
  await first.close();
  assert.equal(existsSync(socketPath), false);
  assert.equal(existsSync(descriptorPath), false);

  const older = await openEndpoint({ agentDir, sessionId: SID_B, version: "0.1.0", handle: statusHandle(SID_B, "o") });
  const newer = { ...readDescriptor(older.descriptorPath), nonce: "f".repeat(32) };
  writeFileSync(older.descriptorPath, JSON.stringify(newer));
  await older.close();
  assert.equal(readDescriptor(older.descriptorPath).nonce, newer.nonce);
});

test("too-long socket paths fall back to a private temp directory recorded in the descriptor", async (t) => {
  const root = scratch(t);
  const agentDir = join(root, "a".repeat(120));
  const tmp = join(root, "t");
  const endpoint = await openEndpoint({ agentDir, sessionId: SID_A, version: "0.1.0", tmp, handle: statusHandle(SID_A, "n") });
  t.after(() => endpoint.close());
  assert.ok(Buffer.byteLength(join(agentDir, "hc-control", `${SID_A}.sock`)) > MAX_SOCKET_PATH_BYTES);
  assert.ok(endpoint.socketPath.startsWith(join(tmp, "hc-ctl-")));
  assert.equal(readDescriptor(endpoint.descriptorPath).socket, endpoint.socketPath);
  assert.equal(statSync(join(endpoint.socketPath, "..")).mode & 0o777, 0o700);
  assert.equal((await request(endpoint.socketPath, { op: "status" })).value.sessionId, SID_A);
});

test("stale descriptors: dead pid is swept and refused; nonce mismatch is refused", async (t) => {
  const agentDir = scratch(t);
  const dir = join(agentDir, "hc-control");
  const live = await openEndpoint({ agentDir, sessionId: SID_A, version: "0.1.0", nonce: "a".repeat(32), handle: statusHandle(SID_A, "a".repeat(32)) });
  t.after(() => live.close());
  assert.equal((await findSession(SID_A, { agentDir })).live, true);

  // Same live socket, but a descriptor from an earlier start of the process.
  const wrongNonce = { ...readDescriptor(live.descriptorPath), nonce: "b".repeat(32) };
  assert.deepEqual(await probe(wrongNonce, { dir }), { live: false, reason: "nonce_mismatch" });

  // A crashed Session left its descriptor and socket behind.
  const dead = { schema: "hc-control/1", sessionId: SID_B, sessionFile: null, pid: deadPid(), nonce: "c".repeat(32), startedAt: new Date(0).toISOString(), version: "0.1.0" };
  writeFileSync(join(dir, `${SID_B}.json`), JSON.stringify(dead));
  writeFileSync(join(dir, `${SID_B}.sock`), "");
  assert.deepEqual(await findSession(SID_B, { agentDir }), { live: false, reason: "dead_pid" });
  const next = await openEndpoint({ agentDir, sessionId: randomUUID(), version: "0.1.0", handle: statusHandle("c", "c") });
  t.after(() => next.close());
  assert.equal(existsSync(join(dir, `${SID_B}.json`)), false);
  assert.equal(existsSync(join(dir, `${SID_B}.sock`)), false);
  assert.equal(existsSync(live.descriptorPath), true, "live descriptors are kept");
});

test("extension moves its socket when the runtime switches Session, and cleans up on shutdown", async (t) => {
  const agentDir = scratch(t);
  const handlers = new Map();
  const pi = {
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    events: { on() {} },
    sendUserMessage() {},
  };
  const emit = async (name, event, ctx) => {
    for (const fn of handlers.get(name) ?? []) await fn({ type: name, ...event }, ctx);
  };
  const ctxFor = (sessionId) => ({
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/synthetic/${sessionId}.jsonl`, getEntries: () => [] },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    ui: { notify() {} },
  });
  createHcControlExtension({ agentDir })(pi);
  await emit("session_start", { reason: "startup" }, ctxFor(SID_A));
  const a = await findSession(SID_A, { agentDir });
  assert.equal(a.live, true);
  assert.equal(a.status.idle, true);
  assert.deepEqual(a.status.pending, { steer: 0, followUp: 0 });

  await emit("session_start", { reason: "new" }, ctxFor(SID_B));
  assert.equal(existsSync(join(agentDir, "hc-control", `${SID_A}.json`)), false);
  assert.equal(existsSync(a.socketPath), false);
  const b = await findSession(SID_B, { agentDir });
  assert.equal(b.live, true);
  assert.notEqual(b.status.nonce, a.status.nonce);
  assert.equal(b.status.sessionFile, `/synthetic/${SID_B}.jsonl`);

  await emit("session_shutdown", { reason: "quit" });
  assert.equal(existsSync(join(agentDir, "hc-control", `${SID_B}.json`)), false);
  assert.equal(existsSync(b.socketPath), false);
});
