// Maintenance ships the same self-contained bundle over local stdin or SSH.
// Only the Host bundle reads credentials, settings and the selected version.
import { spawn, execFile } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PiHostConfig } from "../../pi/host.ts";
import { sshOptions } from "../../shared/host-transport.ts";
import { serviceStatus, type ServiceStatus } from "./status.ts";
import type { ManageOperation } from "./entry.ts";
const exec = promisify(execFile);
let bundlePromise: Promise<string> | undefined;
export function serviceBundle(): Promise<string> {
 return bundlePromise ??= (async () => {
  const script = fileURLToPath(new URL("../../../scripts/build-arc-service.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "ampi-arc-bundle-"));
  try {
   const { stdout } = await exec(process.execPath, [script, join(dir, "service.mjs")], { maxBuffer: 1024 * 1024 });
   return readFileSync(JSON.parse(stdout).output, "utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 })().catch(e => { bundlePromise = undefined; throw e; });
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function maintenanceLaunch(config: PiHostConfig) {
 if (config.kind === "pi-local") return { command: config.remoteNode ?? process.execPath, args: ["--input-type=module"] };
 // remoteNode is an executable path, not shell text.
 const command = `exec ${quote(config.remoteNode ?? "node")} --input-type=module`;
 return { command: "ssh", args: [...sshOptions(true), ...(config.sshArgs ?? []), "--", config.target ?? config.id, `sh -lc ${quote(command)}`] };
}
export async function maintainHost(config: PiHostConfig, operation: Omit<ManageOperation, "host">, body?: string): Promise<any> {
 const serviceLogPath = join(typeof config.agentConfig?.agentDir === "string" ? config.agentConfig.agentDir : "~/.pi/agent", "ampi-arc", "service.log");
 const status = (facts: Partial<ServiceStatus>) => serviceStatus(config.id, { serviceLogPath, ...facts });
 try { body ??= await serviceBundle(); } catch { return status({ state: "error", detail: "Arc service bundle could not be built. Run npm run build:arc in apps/ampi, then retry." }); }
 const op: ManageOperation = { ...operation, host: config.id, ...(typeof config.agentConfig?.agentDir === "string" ? { agentDir: config.agentConfig.agentDir } : {}) };
 const source = `const body=${JSON.stringify(body)};try{const m=await import('data:text/javascript;base64,'+Buffer.from(body).toString('base64'));console.log(JSON.stringify(await m.manage(body,${JSON.stringify(op)})));}catch(e){console.log(JSON.stringify({state:e.state??'error',detail:e.message,prerequisite:e.prerequisite,serviceLogPath:e.serviceLogPath}));}\n`;
 const launch = maintenanceLaunch(config);
 return new Promise<ServiceStatus>((resolve) => {
  const child = spawn(launch.command, launch.args, { env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", stderr = "";
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(status({ state: "error", detail: "Arc service maintenance timed out; query status before retrying" })); }, (operation.timeoutMs ?? 330_000) + 15_000);
  child.on("error", () => { clearTimeout(timer); resolve(status(config.kind === "pi-ssh" ? { state: "error", detail: "SSH transport could not start" } : { state: "cannot-start", prerequisite: "node" })); });
  child.stdin.on("error", () => {});
  child.stdout.on("data", b => { output += b; if (output.length > 1024 * 1024) child.kill("SIGKILL"); });
  child.stderr.on("data", b => { stderr = (stderr + b).slice(-8192); });
  child.on("close", code => {
   clearTimeout(timer);
   if (config.kind === "pi-ssh" && code === 255) { resolve(status({ state: "unreachable", detail: "SSH connection failed" })); return; }
   if (config.kind === "pi-ssh" && code === 127) { resolve(status({ state: "cannot-start", prerequisite: "node" })); return; }
   try { const result = JSON.parse(output); if (!result || typeof result.state !== "string") throw new Error(); resolve(status(result)); }
   catch { resolve(status({ state: "error", detail: stderr.trim() || "Arc service returned an invalid maintenance reply" })); }
  });
  child.stdin.end(source);
 });
}
export function parseArcArgs(args: string[]) {
 const op = args[0];
 if (op !== "stop" && op !== "status") throw new Error("usage: ampi arc status [--host ID] [--json] | stop (--host ID | --all)");
 let host: string | undefined, json = false, all = false, config: string | undefined;
 for (let n = 1; n < args.length; n++) {
  const arg = args[n];
  if (arg === "--json") json = true;
  else if (arg === "--all") all = true;
  else if (arg === "--host" || arg === "--config") {
   const value = args[++n]; if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
   if (arg === "--host") host = value; else config = value;
  } else throw new Error(`Unknown Arc option: ${arg}`);
 }
 if (host && all) throw new Error("--host and --all are mutually exclusive");
 if (op === "stop" && !host && !all) throw new Error("Arc stop requires --host ID or --all");
 return { op: op as "stop" | "status", host, all, json, config };
}
