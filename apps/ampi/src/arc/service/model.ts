// Pi credentials and process lifetime stay on the Session Host. The shared CLI
// runner owns framing and isolation; this adapter owns the durable stdin barrier.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { runPiCall } from "../../pi/isolated-call.ts";
import type { ModelPort, ModelFailure, ModelResult } from "../core/index.ts";
import type { BuildRecord } from "../../shared/arc.ts";
import { inspectProcess } from "./process.ts";

const exec = promisify(execFile);
export type PiModelOptions = { agentDir: string; extensionPath: string; env?: NodeJS.ProcessEnv; checked?(result: ModelFailure | undefined): void };
export function piModel(options: PiModelOptions): ModelPort & { preflight(exact: string): Promise<ModelFailure | undefined> } {
 const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PI_CODING_AGENT_DIR: options.agentDir, PI_OFFLINE: "1",
  PI_SESSION_ID: undefined, PI_SESSION_FILE: undefined, AMPI_ARC_LOCK_FD: undefined, AMPI_ARC_STORE: undefined };
 async function check(exact: string): Promise<ModelFailure | undefined> {
  const settingsPath = join(options.agentDir, "settings.json"), settingsKey = "ampi_arc.model", authPath = join(options.agentDir, "auth.json");
  if (!/^[^\s/:]+\/[^\s:]+$/.test(exact)) return { kind: "failed", code: "settings", settingsPath, settingsKey, message: `${settingsPath}: ${settingsKey}: must name provider/modelId` };
  try {
   const { stdout } = await exec(env.PI_BIN || "pi", ["auth", "check", "--model", exact, "--json"], { env, timeout: 15_000, maxBuffer: 64 * 1024 });
   if (JSON.parse(stdout).status !== "ready") throw new Error("Invalid Pi auth reply");
   return undefined;
  } catch (e) {
   const code = (e as { code?: string | number }).code;
   if (code === "ENOENT") return { kind: "failed", code: "model", prerequisite: "pi", message: "Pi executable is missing" };
   let status: string | undefined;
   try { status = JSON.parse((e as { stdout?: string }).stdout ?? "").status; } catch {}
   if (code === 1 && status === "not_ready") return { kind: "failed", code: "sign-in", authPath, message: `${exact}: no usable sign-in at ${authPath}` };
   if (code === 2 && status === "invalid") return { kind: "failed", code: "settings", settingsPath, settingsKey, message: `${settingsPath}: ${settingsKey}: Pi rejected this model` };
   return { kind: "failed", code: "model", prerequisite: "pi-auth-check", message: "Pi auth check is unavailable or did not finish" };
  }
 }
 async function preflight(exact: string) { const result = await check(exact); options.checked?.(result); return result; }
 return {
  preflight,
  async reconcile(identity) {
   const probe = await inspectProcess(identity.pid);
   return probe.kind === "gone" || probe.kind === "found" && probe.startedAt !== identity.startedAt ? "gone" : "running";
  },
  async call(input, exact, _permit, context): Promise<ModelResult> {
   const refused = await preflight(exact); if (refused) return refused;
   try {
    const answer = await runPiCall({ ...input, model: exact, resolved: true }, undefined, {
     env, extensionPath: options.extensionPath,
     started: async pid => {
      const probe = await inspectProcess(pid);
      if (probe.kind !== "found") throw new Error("Cannot verify the model process start identity");
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
