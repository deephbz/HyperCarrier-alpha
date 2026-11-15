// Probe the model runner where it executes. Hub and Host adapters share the Pi auth protocol.
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { ModelFailure } from "./core/types.ts";
export async function checkPiModel(exact: string, options: { agentDir: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<ModelFailure | undefined> {
 const signal = options.signal;
 const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PI_CODING_AGENT_DIR: options.agentDir, PI_OFFLINE: "1", PI_SESSION_ID: undefined, PI_SESSION_FILE: undefined, AMPI_ARC_LOCK_FD: undefined, AMPI_ARC_STORE: undefined };
  const settingsPath = join(options.agentDir, "settings.json"), settingsKey = "ampi_arc.model", authPath = join(options.agentDir, "auth.json");
  if (!/^[^\s/:]+\/[^\s:]+$/.test(exact)) return { kind: "failed", code: "settings", settingsPath, settingsKey, message: `${settingsPath}: ${settingsKey}: must name provider/modelId` };
  try {
   signal?.throwIfAborted();
   const stdout = await new Promise<string>((resolve, reject) => {
    let result: { error: Error | null; stdout: string };
    const child = execFile(env.PI_BIN || "pi", ["auth", "check", "--model", exact, "--json"], { env, timeout: 15_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL" }, (error, stdout) => { result = { error, stdout }; });
    // execFile's signal abort sends SIGTERM even with killSignal. Reap an uncooperative auth child too.
    const abort = () => { child.kill("SIGKILL"); };
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    child.once("close", () => {
     signal?.removeEventListener("abort", abort);
     result.error ? reject(Object.assign(result.error, { stdout: result.stdout })) : resolve(result.stdout);
    });
   });
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
