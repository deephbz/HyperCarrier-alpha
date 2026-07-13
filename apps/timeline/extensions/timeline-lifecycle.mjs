import { appendFileSync, chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const SCHEMA_VERSION = 1;
export const DEFAULT_HEARTBEAT_MS = 5_000;

const GLOBAL_KEY = Symbol.for("pi-session-timeline.process-boot.v1");

export function parseTmuxEnvironment(env = process.env) {
  if (!env.TMUX_PANE) return undefined;
  const socket = env.TMUX?.split(",", 1)[0] || undefined;
  return { serverSocket: socket, paneId: env.TMUX_PANE };
}

export function getProcessBoot(now = new Date()) {
  const root = globalThis;
  if (!root[GLOBAL_KEY]) {
    root[GLOBAL_KEY] = {
      processBootId: randomUUID(),
      startedAt: new Date(now.getTime() - process.uptime() * 1000).toISOString(),
      processStartedEmitted: false,
    };
  }
  return root[GLOBAL_KEY];
}

export function defaultEventDir(env = process.env) {
  return env.PI_TIMELINE_EVENT_DIR || join(homedir(), ".pi", "agent", "timeline", "events");
}

export function defaultLiveDir(env = process.env) {
  return env.PI_TIMELINE_LIVE_DIR || join(homedir(), ".pi", "agent", "timeline", "live");
}

export function createJsonlSink(filePath) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  return (record) =>
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function createAtomicJsonSink(filePath) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  return (record) => {
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
  };
}

export function createLifecycleExtension(options = {}) {
  const now = options.now || (() => new Date());
  const env = options.env ?? process.env;
  const boot = options.boot || getProcessBoot(now());
  const runtimeId = randomUUID();
  const eventDir = options.eventDir || defaultEventDir();
  const filePath = options.filePath || join(eventDir, `${boot.processBootId}.jsonl`);
  const sink = options.sink || createJsonlSink(filePath);
  const livePath =
    options.livePath || join(options.liveDir || defaultLiveDir(), `${boot.processBootId}.json`);
  const liveSink = options.liveSink || createAtomicJsonSink(livePath);
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const clock = () => now().toISOString();
  let ctx;
  let attachmentId;
  let agentRunId;
  let workState = "idle";
  let activeTool;
  let timer;
  let lastEventAt = boot.startedAt;

  const sessionId = () => ctx?.sessionManager?.getSessionId?.() || undefined;
  const contextSnapshot = () => {
    const usage = ctx?.getContextUsage?.();
    return {
      model: ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      context: usage
        ? { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent }
        : undefined,
    };
  };
  const writeLive = (heartbeatAt = clock()) =>
    liveSink({
      schemaVersion: SCHEMA_VERSION,
      processInstanceId: boot.processBootId,
      processBootId: boot.processBootId,
      extensionRuntimeId: runtimeId,
      processStartedAt: boot.startedAt,
      pid: process.pid,
      sessionId: sessionId(),
      sessionFile: ctx?.sessionManager?.getSessionFile?.(),
      sessionName: ctx?.sessionManager?.getSessionName?.(),
      attachmentId,
      heartbeatAt,
      lastEventAt,
      leaseMs: Math.max(heartbeatMs * 3, 1_000),
      cwd: ctx?.cwd || process.cwd(),
      state: workState,
      activeTool,
      tmux: parseTmuxEnvironment(env),
      ...contextSnapshot(),
    });
  const emit = (type, payload = {}) => {
    const at = clock();
    lastEventAt = at;
    sink({
      schemaVersion: SCHEMA_VERSION,
      eventId: randomUUID(),
      type,
      at,
      observedAt: at,
      host: hostname(),
      processBootId: boot.processBootId,
      extensionRuntimeId: runtimeId,
      ...payload,
    });
  };
  const observe = (state, details = {}) => {
    workState = state;
    activeTool = details.tool;
    emit("state_observed", { sessionId: sessionId(), attachmentId, agentRunId, state, ...details });
  };
  const heartbeat = () => {
    const heartbeatAt = clock();
    emit("heartbeat", {
      sessionId: sessionId(),
      attachmentId,
      agentRunId,
      state: workState,
      tool: activeTool,
      leaseMs: Math.max(heartbeatMs * 3, 1_000),
      ...contextSnapshot(),
    });
    writeLive(heartbeatAt);
  };

  return function timelineLifecycle(pi) {
    if (!boot.processStartedEmitted) {
      emit("process_started", {
        pid: process.pid,
        processStartedAt: boot.startedAt,
        cwd: process.cwd(),
        tmux: parseTmuxEnvironment(env),
      });
      boot.processStartedEmitted = true;
    }
    emit("extension_runtime_started", { pid: process.pid, filePath });

    pi.on("session_start", (event, eventCtx) => {
      ctx = eventCtx;
      attachmentId = randomUUID();
      emit("session_attached", {
        sessionId: sessionId(),
        attachmentId,
        reason: event.reason,
        cwd: eventCtx.cwd,
        sessionFile: eventCtx.sessionManager.getSessionFile?.(),
        name: pi.getSessionName?.() ?? eventCtx.sessionManager.getSessionName?.(),
        tmux: parseTmuxEnvironment(env),
        ...contextSnapshot(),
      });
      observe("idle");
      clearInterval(timer);
      if (heartbeatMs > 0) {
        timer = setInterval(heartbeat, heartbeatMs);
        timer.unref?.();
      }
      heartbeat();
    });
    pi.on("session_info_changed", (event) =>
      emit("session_named", {
        sessionId: sessionId(),
        attachmentId,
        name: event.name ?? null,
      }),
    );
    pi.on("agent_start", () => {
      agentRunId = randomUUID();
      emit("agent_run_started", {
        sessionId: sessionId(),
        attachmentId,
        agentRunId,
        ...contextSnapshot(),
      });
      observe("thinking");
      writeLive();
    });
    pi.on("turn_start", (event) =>
      emit("model_step_started", {
        sessionId: sessionId(),
        attachmentId,
        agentRunId,
        stepIndex: event.turnIndex,
      }),
    );
    pi.on("turn_end", (event) =>
      emit("model_step_ended", {
        sessionId: sessionId(),
        attachmentId,
        agentRunId,
        stepIndex: event.turnIndex,
        outcome: event.message?.stopReason || "unknown",
        ...contextSnapshot(),
      }),
    );
    pi.on("tool_execution_start", (event) => {
      observe("tool", { tool: event.toolName });
      writeLive();
    });
    pi.on("tool_execution_end", (event) => {
      observe(event.isError ? "failed" : "thinking", {
        tool: event.toolName,
        outcome: event.isError ? "error" : "ok",
      });
      writeLive();
    });
    pi.on("session_compact", (event) =>
      emit("compaction_completed", {
        sessionId: sessionId(),
        attachmentId,
        agentRunId,
        reason: event.reason,
        willRetry: event.willRetry,
        ...contextSnapshot(),
      }),
    );
    pi.on("agent_settled", () => {
      emit("agent_run_settled", {
        sessionId: sessionId(),
        attachmentId,
        agentRunId,
        ...contextSnapshot(),
      });
      observe("idle");
      agentRunId = undefined;
      writeLive();
    });
    pi.on("model_select", (event) =>
      emit("model_selected", {
        sessionId: sessionId(),
        attachmentId,
        model: { provider: event.model.provider, id: event.model.id },
        source: event.source,
      }),
    );
    pi.on("session_shutdown", (event) => {
      clearInterval(timer);
      emit("session_detached", {
        sessionId: sessionId(),
        attachmentId,
        reason: event.reason,
        ...contextSnapshot(),
      });
      emit("extension_runtime_stopped", { reason: event.reason });
      if (event.reason === "quit") {
        workState = "stopped";
        emit("process_stopping", { pid: process.pid, reason: "quit" });
        writeLive(clock());
      }
      ctx = undefined;
      attachmentId = undefined;
    });
  };
}

export default function timelineLifecycle(pi) {
  return createLifecycleExtension()(pi);
}
