// Structured service facts are the shared maintenance contract. Diagnostic text
// never chooses a state or an action. Transport uncertainty keeps facts null.
import type { Stamp } from "./engine.ts";
export type ServiceState = "running" | "stopped" | "updating" | "stopping" | "fault" | "no-sign-in" | "invalid-settings" | "cannot-start" | "unreachable" | "error" | "busy" | "not-configured";
export type ServiceStatus = {
 stamp?: Stamp; code?: string;
 host: string; state: ServiceState; running: boolean | null;
 serviceVersion: string | null; releaseLine: string | null; buildOrder: number | null;
 pid: number | null; storeSchema: number | null; bundleSchema: number | null;
 kind?: string; prerequisite?: "node" | "perl" | "pi" | "pi-auth-check";
 model?: string; authPath?: string; settingsPath?: string; settingsKey?: string; serviceLogPath?: string; detail?: string;
 [key: string]: unknown;
};
export function serviceStatus(host: string, facts: Partial<ServiceStatus> = {}): ServiceStatus {
 return { state: "error", running: null, serviceVersion: null, releaseLine: null, buildOrder: null, pid: null, storeSchema: null, bundleSchema: null, ...facts, host };
}
export function serviceError(host: string, error: unknown): ServiceStatus {
 const e = error as Partial<ServiceStatus> & { message?: string };
 return serviceStatus(host, { state: e.state ?? "error", detail: e.message ?? "Arc maintenance failed", ...(e.prerequisite ? { prerequisite: e.prerequisite } : {}), ...(e.settingsPath ? { settingsPath: e.settingsPath, settingsKey: e.settingsKey } : {}), ...(e.serviceLogPath ? { serviceLogPath: e.serviceLogPath } : {}) });
}
export function replacementText(host: string, cause: string, log = "~/.pi/agent/ampi-arc/service.log"): string {
 return `${host}: AmPi could not replace the older Arc service (${cause}). Run ampi arc status --host ${host}; the log is ${log}.`;
}
export function serviceText(s: ServiceStatus): string {
 const host = s.host, action = (op: string) => `ampi arc ${op} --host ${host}`;
 if ((s.code === "build-mismatch" || s.code === "replacement-failed") && s.detail) return s.detail;
 switch (s.state) {
  case "running": return `${host}: Arc service is running${s.serviceVersion ? " (" + s.serviceVersion + ")" : ""}.`;
  case "stopped": return `${host}: Arc service is stopped. A linked hub restarts it within seconds.`;
  case "updating": return `${host}: Arc service is draining Builds for an update.`;
  case "stopping": return `${host}: Arc service is stopping for every client. A linked hub restarts it within seconds.`;
  case "no-sign-in": return `${host}: Arc service has no sign-in for ${s.model}. Sign in using ${s.authPath}.`;
  case "invalid-settings": return s.settingsKey === "$" ? `${host}: ${s.settingsPath} is not valid JSON. Fix the file, then run ${action("status")}.` : `${host}: Arc settings are invalid. Check ${s.settingsKey} in ${s.settingsPath}.`;
  case "cannot-start": return s.prerequisite === "pi-auth-check" ? `${host}: Arc service cannot start: this Pi has no pi auth check. Update Pi on ${host}.` : `${host}: Arc service cannot start: ${s.prerequisite ? s.prerequisite + " is missing" : "check " + (s.serviceLogPath ?? "~/.pi/agent/ampi-arc/service.log")}.`;
  case "fault": return `${host}: Arc service stopped Builds after an internal error. Run ${action("stop")} to restart it; a linked hub starts it again within seconds.`;
  case "unreachable": return `${host}: Host is unreachable. Check the SSH connection, then run ${action("status")}.`;
  case "busy": return `${host}: Arc service holds its lock but does not answer. Run ${action("status")} before retrying.`;
  case "not-configured": return `${host}: not in hub.json.`;
  case "error": return `${host}: Arc maintenance failed: ${s.detail ?? "the service did not return a usable reply"}. Run ${action("status")}; the log is ${s.serviceLogPath ?? "~/.pi/agent/ampi-arc/service.log"}.`;
 }
}
