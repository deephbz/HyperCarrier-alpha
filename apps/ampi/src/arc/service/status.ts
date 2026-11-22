// Structured service facts are the shared maintenance contract. Diagnostic text
// never chooses a state or an action. Transport uncertainty keeps facts null.
import type { Stamp } from "./engine.ts";
import type { RecoveryVisibility } from "./recovery-linux.ts";
export type ServiceState = "running" | "stopped" | "updating" | "stopping" | "fault" | "no-sign-in" | "invalid-settings" | "cannot-start" | "unreachable" | "error" | "busy" | "not-configured";
export type RecoveryResult = {
 visibility?: RecoveryVisibility;
 /** "unverified": macOS matched the process by open file, start time and command only. */
 evidence?: "unverified";
 pid: number; signals: readonly ("SIGTERM" | "SIGKILL")[]; oldHolderEnded: true; interveningDispatch: "unknown";
} & ({ cancellation: "confirmed" } | { cancellation: "unconfirmed"; reason: string; action: string });
export type ServiceStatus = {
 recovery?: RecoveryResult; recoveryVisibility?: RecoveryVisibility;
 cancellationPersisted?: boolean;
 recoveryUncertainty?: "unknown-prior-stop"; recoveryFault?: string; recoveryAction?: string;
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
 if (s.kind === "forced-recovery" && s.recovery) {
  const r = s.recovery, signals = r.signals.join(" and ");
  const proof = r.evidence === "unverified" ? `\nmacOS could not prove that pid ${r.pid} held the lock. You chose to stop it anyway.` : "";
  if (r.cancellation === "confirmed") return `Arc service on ${host} did not answer, so AmPi stopped it.\nSent ${signals} to pid ${r.pid}. The process ended, and AmPi took the lock and cancelled the queued Builds.${proof}\nA Build that the signals interrupted may have charged a model call. Before AmPi took the lock, another Arc service may also have started a Build and charged one.\nCheck your model provider's usage page. A linked hub starts Arc again within seconds.`;
  return `Arc recovery on ${host} is not complete: ${r.reason.replace(/^The /, "the ")}.\nSent ${signals} to pid ${r.pid}. The process ended, but AmPi could not confirm that queued Builds are cancelled.${proof}\nA Build that the signals interrupted may have charged a model call. Another Arc service may also have started a Build and charged one.\n${r.action}.`;
 }
 if (s.recoveryUncertainty === "unknown-prior-stop") {
  const warning = "The earlier stop may have interrupted a Build, and another Arc service may have started one. Either may have charged a model call.";
  if (s.state === "stopped" && s.running === false) return `Arc stop on ${host} could not read the record of an earlier stop, so it cancelled the queued Builds.\nThis command sent no signal. AmPi does not know which signals the earlier stop sent.\n${warning}\nCheck your model provider\'s usage page.`;
  return `Arc stop on ${host} could not recover: the record of an earlier stop is unreadable, and ${s.recoveryFault ?? s.detail ?? "lock acquisition was not confirmed"}.\nThis command sent no signal. ${s.cancellationPersisted ? "Queued Builds are cancelled. AmPi could not save the final stop record." : "Queued Builds are not cancelled and may still run."}\n${warning}\n${s.recoveryAction ?? `Run ${action("stop")} again.`}`;
 }
 if (s.kind === "orderly-stop") return `Arc service on ${host} stopped. A linked hub starts it again within seconds.`;
 if (s.kind === "not-running") return `Arc service on ${host} is not running. Nothing to stop. No signal sent.`;
 if (s.kind === "recovery-refused" && s.detail) return s.detail;
 if (s.kind === "forced-recovery" && s.state === "fault" && s.detail) return s.detail;
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
  case "busy": return `${host}: Arc service holds its lock but does not answer. Run ${action("stop")} to stop it; a linked hub starts it again within seconds.`;
  case "not-configured": return `${host}: not in hub.json.`;
  case "error": return `${host}: Arc maintenance failed: ${s.detail ?? "the service did not return a usable reply"}. Run ${action("status")}; the log is ${s.serviceLogPath ?? "~/.pi/agent/ampi-arc/service.log"}.`;
 }
}
