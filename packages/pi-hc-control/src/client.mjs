// Minimal client for hc-control/1: find a live Session endpoint and talk to it.
import { randomUUID } from "node:crypto";
import net from "node:net";
import { join } from "node:path";
import { controlDir, pidAlive, readDescriptor, resolveAgentDir } from "./endpoint.mjs";

/** Open a connection that sends frames and resolves replies by id. */
export function connect(socketPath, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const waiting = new Map();
    let buffer = "";
    const failAll = (error) => {
      for (const { reject: rejectOne, timer } of waiting.values()) {
        clearTimeout(timer);
        rejectOne(error);
      }
      waiting.clear();
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const reply = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const entry = waiting.get(reply.id);
        if (!entry) continue;
        waiting.delete(reply.id);
        clearTimeout(entry.timer);
        entry.resolve(reply);
      }
    });
    socket.once("error", (error) => {
      failAll(error);
      reject(error);
    });
    socket.on("close", () => failAll(new Error("connection closed")));
    socket.once("connect", () =>
      resolve({
        request(frame, { timeoutMs: limit = timeoutMs } = {}) {
          const id = frame.id ?? randomUUID();
          return new Promise((resolveOne, rejectOne) => {
            const timer = setTimeout(() => {
              waiting.delete(id);
              rejectOne(new Error(`timed out waiting for ${frame.op}`));
            }, limit);
            waiting.set(id, { resolve: resolveOne, reject: rejectOne, timer });
            socket.write(`${JSON.stringify({ ...frame, id })}\n`);
          });
        },
        close: () => socket.end(),
      }),
    );
  });
}

/** One request over a fresh connection. */
export async function request(socketPath, frame, options) {
  const client = await connect(socketPath, options);
  try {
    return await client.request(frame, options);
  } finally {
    client.close();
  }
}

/**
 * A descriptor names a live Session only if its pid is alive and its socket
 * answers `status` with the same sessionId and nonce.
 */
export async function probe(descriptor, { dir, timeoutMs = 2_000 } = {}) {
  if (!descriptor) return { live: false, reason: "missing" };
  if (!pidAlive(descriptor.pid)) return { live: false, reason: "dead_pid" };
  const socketPath = descriptor.socket ?? join(dir ?? controlDir(), `${descriptor.sessionId}.sock`);
  let reply;
  try {
    reply = await request(socketPath, { op: "status" }, { timeoutMs });
  } catch (error) {
    return { live: false, reason: "unreachable", message: String(error?.message ?? error) };
  }
  if (!reply.ok || reply.value?.nonce !== descriptor.nonce || reply.value?.sessionId !== descriptor.sessionId)
    return { live: false, reason: "nonce_mismatch" };
  return { live: true, socketPath, status: reply.value };
}

/** Find the live endpoint for a Session id, or explain why there is none. */
export async function findSession(sessionId, { agentDir = resolveAgentDir(), timeoutMs } = {}) {
  const dir = controlDir(agentDir);
  return probe(readDescriptor(join(dir, `${sessionId}.json`)), { dir, timeoutMs });
}
