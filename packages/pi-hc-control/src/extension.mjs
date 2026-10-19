// Pi extension: one hc-control/1 endpoint per live Session (apps/ampi/docs/pi-backend.md §1).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createControl } from "./control.mjs";
import { openEndpoint, resolveAgentDir } from "./endpoint.mjs";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * Options: `agentDir`, `listen` (transport override for tests), and the
 * control timings `holdWaitMs`, `admitTimeoutMs`, `abortTimeoutMs`.
 */
export function createHcControlExtension(options = {}) {
  return function hcControl(pi) {
    const control = createControl(pi, options);
    let endpoint;
    let opening = Promise.resolve();

    const close = async () => {
      control.detach();
      const current = endpoint;
      endpoint = undefined;
      await current?.close();
    };

    pi.on("session_start", async (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
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
          ctx.ui?.notify?.(
            `HC control: no control socket for this Session, so the GUI will fall back to pane keys. ${error?.message ?? error}`,
            "warning",
          );
        }
      });
      await opening;
    });

    pi.on("session_shutdown", async () => {
      opening = opening.then(close);
      await opening;
    });
  };
}

export default createHcControlExtension();
