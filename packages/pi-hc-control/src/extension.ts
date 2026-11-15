// Pi extension: one hc-control/1 endpoint per live Session (apps/ampi/docs/pi-backend.md §1).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createControl } from "./control.ts";
import { openEndpoint, resolveAgentDir } from "./endpoint.ts";
import { controlStamp } from "./stamp.ts";
import { createSelfUpdate } from "./update.ts";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
/** How long a reloading descriptor asks clients to wait for the reloaded endpoint. */
export const RELOAD_HOLD_MS = 10_000;
/** Cache Goblin sets this when its /cache TTL survives a reload (pi-cache-goblin src/extension.mjs). */
const CACHE_GOBLIN_PERSISTENCE = Symbol.for("cache-goblin.persistence");
/** Cache Goblin's /cache command, by its package path: Pi docs name sourceInfo as the provenance. */
export const isCacheGoblin = (command) =>
  command?.source === "extension" && command.name === "cache" && /[\\/]pi-cache-goblin[\\/]/.test(command.sourceInfo?.path ?? "");
let stamp: ReturnType<typeof controlStamp> | undefined;
/** This build, computed once per load and only when no `stamp` option names it; status reports it. */
export function buildStamp() {
  return (stamp ??= controlStamp());
}

/**
 * Options: `agentDir`, `listen` (transport override for tests), `stamp`
 * (the build status reports; default buildStamp()), and the
 * control timings `holdWaitMs`, `admitTimeoutMs`, `abortTimeoutMs`.
 * `selfUpdate` overrides self-update options (update.ts) and `isCacheGoblin` the
 * Cache Goblin command match, for tests.
 */
export function createHcControlExtension(options = {}) {
  return function hcControl(pi) {
    const loaded = "stamp" in options ? options.stamp : buildStamp();
    let selfUpdate;
    const control = createControl(pi, { ...options, stamp: loaded, onExpect: (stamp) => selfUpdate?.expect(stamp) });
    let ui;
    let sessionId;
    let endpoint;
    let opening = Promise.resolve();
    // The build a self-update reload is loading; null for a manual /reload.
    let reloadTarget: ReturnType<typeof controlStamp> = null;
    // Active custom compaction method runs, by token (hc-auto-compact README, `hc.compaction-method`). A reload
    // would cancel the run, so self-update waits for the release; the claim owner releases on cancellation too.
    const compactionClaims = new Set<string>();

    selfUpdate = createSelfUpdate({
      loaded,
      sessionId: () => sessionId,
      quiet: () => {
        const s = control.status();
        return s.idle && !s.compacting && !s.held && !compactionClaims.size && !s.pending.steer && !s.pending.followUp;
      },
      reload: (target) => {
        reloadTarget = target;
        // A command, so it runs after the settled handlers and never reaches the model (Pi docs, ctx.reload()).
        // Without expandPromptTemplates, Pi skips command dispatch and sends the text to the model.
        pi.sendUserMessage("/hc-control-reload", { expandPromptTemplates: true });
      },
      notify: (text, level) => ui?.notify?.(text, level),
      // An older Cache Goblin keeps /cache only in memory: a reload would drop the owner's 1h TTL.
      restartReason: () =>
        (pi.getCommands?.() ?? []).some(options.isCacheGoblin ?? isCacheGoblin) && !globalThis[CACHE_GOBLIN_PERSISTENCE]
          ? "the loaded Cache Goblin keeps its /cache TTL in memory only, so a reload would reset it"
          : null,
      ...options.selfUpdate,
    });
    for (const name of ["input", "agent_start", "turn_start", "message_start", "message_end", "tool_execution_start", "tool_execution_end", "session_compact"])
      pi.on(name, () => selfUpdate.activity());
    pi.on("agent_settled", () => selfUpdate.settled());
    pi.events?.on?.("hc.compaction-method", (claim) => {
      if (!claim || typeof claim !== "object" || typeof claim.token !== "string" || typeof claim.active !== "boolean") return;
      if (claim.active) return void compactionClaims.add(claim.token);
      // A release ends work as a settle does: the quiet window starts again.
      if (compactionClaims.delete(claim.token) && !compactionClaims.size) selfUpdate.settled();
    });

    const close = async (options = undefined) => {
      control.detach();
      const current = endpoint;
      endpoint = undefined;
      await current?.close(options);
    };

    pi.on("session_start", async (event, ctx) => {
      sessionId = ctx.sessionManager.getSessionId();
      ui = ctx.ui;
      const sessionFile = ctx.sessionManager.getSessionFile();
      opening = opening.then(async () => {
        // Same runtime moved to another Session: move the socket with it.
        if (endpoint && endpoint.descriptor.sessionId !== sessionId) await close();
        // Random per process start, so a stale descriptor cannot pass for a live Session.
        const nonce = endpoint?.descriptor.nonce ?? randomBytes(16).toString("hex");
        control.attach(ctx, { sessionId, sessionFile: sessionFile ?? null, nonce });
        if (endpoint) return;
        try {
          endpoint = await openEndpoint({
            agentDir: options.agentDir ?? resolveAgentDir(),
            sessionId,
            sessionFile,
            version: VERSION,
            nonce,
            handle: control.handle,
            ...(options.listen ? { listen: options.listen } : {}),
            ...(options.tmp ? { tmp: options.tmp } : {}),
          });
        } catch (error) {
          control.detach();
          // After a reload the reloading descriptor stays while this process lives, so AmPi refuses sends; it never types.
          const effect = event?.reason === "reload" ? "AmPi refuses sends to this Session until you restart this Pi Session" : "the GUI will fall back to pane keys";
          ctx.ui?.notify?.(`HC control: no control socket for this Session, so ${effect}. ${error?.message ?? error}`, "warning");
        }
      });
      await opening;
      if (event?.reason === "reload") selfUpdate.started();
    });

    pi.registerCommand("hc-control-reload", {
      description: "Reload extensions so a pulled pi-hc-control takes effect",
      handler: async (_args, ctx) => {
        await ctx.reload();
      },
    });

    pi.on("session_shutdown", async (event) => {
      selfUpdate.stop();
      // A reload keeps the descriptor as "reloading", so AmPi holds sends for the reloaded endpoint.
      const options = event?.reason === "reload" ? { reloading: { targetStamp: reloadTarget, deadline: Date.now() + RELOAD_HOLD_MS } } : undefined;
      opening = opening.then(() => close(options));
      await opening;
    });
  };
}

export default createHcControlExtension();
