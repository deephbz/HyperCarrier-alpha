// Pi credentials and process lifetime stay on the Session Host. The shared CLI
// runner owns framing and isolation; this adapter owns the durable stdin barrier.
import { checkPiModel } from "../preflight.ts";
import { runPiCall } from "../../pi/isolated-call.ts";
import type { ModelPort, ModelFailure, ModelResult } from "../core/index.ts";
import type { BuildRecord } from "../../shared/arc.ts";
import { inspectProcess } from "./process.ts";

export type PiModelOptions = { agentDir: string; extensionPath: string; env?: NodeJS.ProcessEnv; checked?(result: ModelFailure | undefined): void };
export function piModel(options: PiModelOptions): ModelPort & { preflight(exact: string, signal?: AbortSignal): Promise<ModelFailure | undefined> } {
 const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PI_CODING_AGENT_DIR: options.agentDir, PI_OFFLINE: "1",
  PI_SESSION_ID: undefined, PI_SESSION_FILE: undefined, AMPI_ARC_LOCK_FD: undefined, AMPI_ARC_STORE: undefined };
 async function preflight(exact: string, signal?: AbortSignal) { const result = await checkPiModel(exact, { agentDir: options.agentDir, env, signal }); options.checked?.(result); return result; }
 return {
  preflight,
  async reconcile(identity) {
   const probe = await inspectProcess(identity.pid);
   return probe.kind === "gone" || probe.kind === "found" && probe.startedAt !== identity.startedAt ? "gone" : "running";
  },
  async call(input, exact, _permit, context): Promise<ModelResult> {
   const refused = await preflight(exact, context.signal); if (refused) return refused;
   try {
    const answer = await runPiCall({ ...input, model: exact, resolved: true }, undefined, {
     env, extensionPath: options.extensionPath, signal: context.signal,
     started: async pid => {
      context.signal?.throwIfAborted();
      const probe = await inspectProcess(pid);
      if (probe.kind !== "found") throw new Error("Cannot verify the model process start identity");
      context.signal?.throwIfAborted();
      context.started({ pid, startedAt: probe.startedAt });
     },
     exited: context.exited,
    });
    return { kind: "answer", answer };
   } catch (caught) {
    const e = caught as Error & { code?: string; dispatched?: boolean; modelMismatch?: boolean; usage?: BuildRecord["usage"]; resetAt?: number | string };
    // Preparation and spawn-record failures are proved to precede the prompt.
    if (e.dispatched !== true) return { kind: "failed", code: e.code === "settings" ? "settings" : "model", message: e.message };
    const reset = e.resetAt === undefined ? NaN : typeof e.resetAt === "number" ? e.resetAt : Date.parse(e.resetAt);
    if (e.modelMismatch) return { kind: "measured-unknown", code: "model-mismatch", reason: e.message, usage: e.usage };
    if (e.usage) return { kind: "failed", code: Number.isFinite(reset) ? "quota" : "model", message: e.message, usage: e.usage, ...(Number.isFinite(reset) ? { retryAt: new Date(reset).toISOString() } : {}) };
    return { kind: "measured-unknown", reason: e.message, usage: e.usage };
   }
  },
 };
}
