// Per-Session unix socket and descriptor under <agentDir>/hc-control/.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const SCHEMA = "hc-control/1";
// sockaddr_un.sun_path is 104 bytes on macOS and 108 on Linux, including NUL.
export const MAX_SOCKET_PATH_BYTES = 103;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Pi's own rule (config.js getAgentDir): PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function resolveAgentDir(env = process.env) {
  const dir = env.PI_CODING_AGENT_DIR;
  if (dir) return dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
  return join(homedir(), ".pi", "agent");
}

export const controlDir = (agentDir = resolveAgentDir()) => join(agentDir, "hc-control");

const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** Create or verify a private directory: real directory, ours, mode 0700. */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  const me = uid();
  if (me !== undefined && stat.uid !== me) throw new Error(`${dir} is owned by another user`);
  if ((stat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return dir;
}

const fits = (path) => Buffer.byteLength(path, "utf8") <= MAX_SOCKET_PATH_BYTES;

/** Preferred socket path, or a shorter private fallback when it would not fit. */
export function socketPathFor(dir, sessionId, { tmp = tmpdir() } = {}) {
  const name = `${sessionId}.sock`;
  const preferred = join(dir, name);
  if (fits(preferred)) return { path: preferred, dir };
  const short = `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.sock`;
  const bases = [...new Set([tmp, "/tmp"])].map((base) => join(base, `hc-ctl-${uid() ?? "u"}`));
  for (const base of bases)
    for (const file of [name, short]) if (fits(join(base, file))) return { path: join(base, file), dir: base };
  throw new Error("no socket path fits the platform limit");
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function readDescriptor(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value?.schema === SCHEMA ? value : undefined;
  } catch {
    return undefined;
  }
}

const unlinkQuiet = (path) => {
  try {
    unlinkSync(path);
  } catch {}
};

/** Remove descriptors (and their sockets) whose process is gone. */
export function sweepStale(dir) {
  const removed = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const descriptor = readDescriptor(path);
    if (!descriptor || pidAlive(descriptor.pid)) continue;
    unlinkQuiet(descriptor.socket ?? join(dir, `${descriptor.sessionId}.sock`));
    unlinkQuiet(path);
    removed.push(descriptor.sessionId);
  }
  return removed;
}

function serveConnection(socket, handle) {
  let buffer = "";
  socket.setEncoding("utf8");
  const reply = (value) => {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(value)}\n`);
  };
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_FRAME_BYTES) {
      reply({ id: null, ok: false, error: { code: "too_large", message: "frame exceeds limit" } });
      socket.end();
      buffer = "";
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        reply({ id: null, ok: false, error: { code: "bad_request", message: "invalid JSON" } });
        continue;
      }
      Promise.resolve(handle(frame)).then(reply, (error) =>
        reply({ id: frame?.id ?? null, ok: false, error: { code: "internal", message: String(error) } }),
      );
    }
  });
  socket.on("error", () => {});
}

export function listenUnix(path, handle) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      serveConnection(socket, handle);
    });
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      server.on("error", () => {});
      resolve({
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Open the Session's socket and write its descriptor. Returns `close()`,
 * which removes only what this instance owns (matching nonce).
 */
export async function openEndpoint({
  agentDir = resolveAgentDir(),
  sessionId,
  sessionFile,
  version,
  handle,
  listen = listenUnix,
  tmp,
  nonce = randomBytes(16).toString("hex"),
  pid = process.pid,
}) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]+$/.test(sessionId))
    throw new Error("sessionId is not a safe file name");
  const dir = ensurePrivateDir(controlDir(agentDir));
  sweepStale(dir);
  const socket = socketPathFor(dir, sessionId, { tmp });
  if (socket.dir !== dir) ensurePrivateDir(socket.dir);
  // A previous holder of this path is either dead (swept) or replaced by us.
  unlinkQuiet(socket.path);
  const server = await listen(socket.path, handle);
  try {
    chmodSync(socket.path, 0o600);
  } catch {}
  const descriptor = {
    schema: SCHEMA,
    sessionId,
    sessionFile: sessionFile ?? null,
    pid,
    nonce,
    startedAt: new Date().toISOString(),
    version,
    socket: socket.path,
  };
  const descriptorPath = join(dir, `${sessionId}.json`);
  const temporary = `${descriptorPath}.${nonce}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
  renameSync(temporary, descriptorPath);

  let closed = false;
  const removeOwned = () => {
    const current = readDescriptor(descriptorPath);
    if (current && current.nonce !== nonce) return; // a newer process took this Session
    unlinkQuiet(descriptorPath);
    unlinkQuiet(socket.path);
  };
  const onExit = () => removeOwned();
  process.once("exit", onExit);
  return {
    descriptor,
    descriptorPath,
    socketPath: socket.path,
    async close() {
      if (closed) return;
      closed = true;
      process.off("exit", onExit);
      removeOwned();
      await server.close();
    },
  };
}
