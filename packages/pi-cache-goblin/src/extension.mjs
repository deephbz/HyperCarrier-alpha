// Own request-local cache placement. Compaction, routing, and provider cache hits stay outside this package.
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TTLS, isAnthropicMessagesPayload, placeMarkers } from "./plan.mjs";
import { findGlobalBoundary } from "./system-split.mjs";

export const EVENTS = Object.freeze({
  pin: "cache-goblin:pin",
  unpin: "cache-goblin:unpin",
  placed: "cache-goblin:placed",
});
// The owner's /cache choice, as a custom entry: it never reaches the model and lasts for the Session.
export const TTL_ENTRY = "cache-goblin:ttl";
// A reload replaces the extension but not the process. The last real request's replay state is still true then,
// so a reload hands it to the next instance by Session id; a new process starts without it.
const RELOADS = (globalThis[Symbol.for("cache-goblin.reload")] ??= new Map());
const PERSISTENCE = Symbol.for("cache-goblin.persistence");
const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
export function defaultGlobalPaths(env = process.env) {
  if (env.PI_CACHE_GLOBAL_FILES) return env.PI_CACHE_GLOBAL_FILES.split(":").filter(Boolean);
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return [agentDir, homedir()].flatMap((dir) => CONTEXT_FILE_NAMES.map((name) => join(dir, name)));
}

// Pi's payload hook has no routed API or replay identity. Accept only recognizable
// Messages shapes; treat all one-token payloads as replay for pin admission.
export function createCacheGoblinExtension(userOptions = {}) {
  const options = { sessionTtl: "5m", globalPaths: defaultGlobalPaths(), ...userOptions };
  if (!TTLS.includes(options.sessionTtl)) throw new Error("cache: expected sessionTtl 5m or 1h");
  const globalPaths = new Set(options.globalPaths);
  const log = (record) => {
    // Optional diagnostics must never prevent a provider request.
    try {
      if (options.logPath) appendFileSync(options.logPath, `${JSON.stringify({ t: Date.now(), ...record })}\n`);
    } catch { /* fail open */ }
  };
  return function cacheGoblinExtension(pi) {
    // The /cache TTL survives a reload (the cache-goblin:ttl entry): pi-hc-control self-updates only when this is set.
    globalThis[PERSISTENCE] = 1;
    let sessionTtl = options.sessionTtl;
    let pin;
    let warming = "no supported request observed";
    let lastTtl;
    let replayPins = [];
    const setStatus = (ctx) => ctx?.ui?.setStatus?.("cache-goblin",
      `cache ${sessionTtl}${pin ? " · 1 pin" : ""} · warming ${warming}`);
    const reset = (_event, ctx) => {
      sessionTtl = options.sessionTtl;
      pin = undefined;
      lastTtl = undefined;
      replayPins = [];
      warming = "no supported request observed";
      setStatus(ctx);
    };
    // The held pin never crosses a reload: its owner restarts too (Auto Compact cancels its fork).
    const start = (event, ctx) => {
      reset(event, ctx);
      const id = ctx?.sessionManager?.getSessionId?.();
      const chosen = ctx?.sessionManager?.getEntries?.()
        .findLast((e) => e.type === "custom" && e.customType === TTL_ENTRY && TTLS.includes(e.data?.sessionTtl));
      if (chosen) sessionTtl = chosen.data.sessionTtl;
      const carried = event?.reason === "reload" ? RELOADS.get(id) : undefined;
      RELOADS.clear();
      if (carried) ({ lastTtl, replayPins, warming } = carried);
      setStatus(ctx);
    };
    const shutdown = (event, ctx) => {
      const id = ctx?.sessionManager?.getSessionId?.();
      if (event?.reason === "reload" && id && lastTtl) RELOADS.set(id, { lastTtl, replayPins, warming });
      reset(event, ctx);
    };
    pi.events.on(EVENTS.pin, (data) => {
      if (typeof data?.name === "string" && data.name.trim()) pin = { name: data.name };
    });
    pi.events.on(EVENTS.unpin, (data) => {
      if (typeof data?.name === "string" && pin?.name === data.name) pin = undefined;
    });
    pi.on("session_start", start);
    pi.on("session_switch", reset);
    pi.on("session_shutdown", shutdown);

    pi.on("before_provider_request", (event, ctx) => {
      if (!isAnthropicMessagesPayload(event.payload)) {
        warming = "unsupported payload; policy not applied";
        setStatus(ctx);
        return undefined;
      }
      const replay = event.payload.max_tokens <= 1;
      if (replay && !lastTtl) return undefined;
      const requestTtl = replay ? lastTtl : sessionTtl;
      // Native retention controls Pi's refresh timer. The hook exposes no setting,
      // so use the native last-user marker as evidence of a 5m refresh interval.
      const nativeTail = [...event.payload.messages].reverse().find((m) => m.role === "user");
      const nativeControl = Array.isArray(nativeTail?.content) ? nativeTail.content.at(-1)?.cache_control : undefined;
      try {
        const result = placeMarkers(event.payload, {
          sessionTtl: requestTtl, globalBoundary: (text) => findGlobalBoundary(text, { globalPaths }),
          pins: replay ? replayPins : pin ? [pin] : [], capturePending: !replay,
        });
        if (!replay) {
          const held = result.pins.find((p) => p.status === "placed" || p.status === "unresolved");
          pin = held ? (held.at ? { name: held.name, at: held.at } : { name: held.name }) : undefined;
          lastTtl = sessionTtl;
          replayPins = result.pins.filter((p) => p.status === "placed").map(({ name, at }) => ({ name, at }));
          warming = sessionTtl === "1h" ? "stopped: 1h policy" :
            process.env.PI_CACHE_RETENTION !== "long" && ctx.model?.api === "anthropic-messages" &&
            ctx.model?.id === event.payload.model && ctx.model?.promptCache?.short === 300 &&
            nativeControl?.type === "ephemeral" && (nativeControl.ttl === undefined || nativeControl.ttl === "5m")
              ? "native 5m eligible" : "stopped: native retention unknown or mismatched";
        }
        const summary = { model: event.payload.model, ttl: requestTtl, replay,
          markers: result.markers, pins: result.pins, warming };
        setStatus(ctx);
        log({ kind: "placed", ...summary });
        pi.events.emit(EVENTS.placed, summary);
        return result.payload;
      } catch (error) {
        warming = "stopped: placement failed; policy not applied";
        setStatus(ctx);
        log({ kind: "placement_failed", error: String(error) });
        return undefined;
      }
    });
    pi.on("provider_stream_event", (event) => {
      if (event.api !== "anthropic-messages") return;
      if (event.data?.type === "message_start") log({ kind: "usage", model: event.model, usage: event.data.message?.usage });
      else if (event.data?.type === "message_delta" && event.data.usage) log({ kind: "usage_final", model: event.model, usage: event.data.usage });
    });
    pi.on("cache_warming_decision", (_event, ctx) => {
      if (sessionTtl !== "5m" || lastTtl !== sessionTtl || warming !== "native 5m eligible") {
        setStatus(ctx);
        return { action: "stop" };
      }
      return undefined; // Retain native economics and operator warming mode.
    });
    pi.registerCommand("cache", {
      description: "Cache Goblin session TTL: 5m | 1h | status",
      handler: async (args, ctx) => {
        const arg = String(args ?? "").trim();
        if (TTLS.includes(arg)) {
          const previous = sessionTtl;
          sessionTtl = arg;
          if (previous !== arg) {
            pi.appendEntry?.(TTL_ENTRY, { sessionTtl: arg });
            warming = "stopped: TTL changed; awaiting real request";
            if (previous === "5m" && arg === "1h") ctx.ui?.notify?.(
              "cache: 5m -> 1h rewrites the session prefix at the provider's 1h cache-write rate on the next request.", "warning");
          }
          log({ kind: "ttl", ttl: sessionTtl });
        } else if (arg && arg !== "status") {
          ctx.ui?.notify?.("cache: expected 5m, 1h, or status", "warning");
          return;
        }
        setStatus(ctx);
        ctx.ui?.notify?.(`cache TTL ${sessionTtl}; pin: ${pin?.name ?? "none"}; warming ${warming}`, "info");
      },
    });
  };
}
const envTtl = process.env.PI_CACHE_TTL;
export default createCacheGoblinExtension({
  sessionTtl: TTLS.includes(envTtl) ? envTtl : "5m",
  logPath: process.env.PI_CACHE_GOBLIN_LOG || undefined,
});
