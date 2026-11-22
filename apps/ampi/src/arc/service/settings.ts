// Reuse the canonical Pi settings parser. The service owns only its extra keys.
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { arcSettings, piSettings, settingsError } from "../../shared/pi-config.ts";
export function sessionDirectory(agentDir: string): string {
 const setting = process.env.PI_CODING_AGENT_SESSION_DIR ?? piSettings(join(agentDir, "settings.json")).sessionDir;
 if (setting === undefined) return join(agentDir, "sessions");
 if (typeof setting !== "string" || !setting) throw settingsError(join(agentDir, "settings.json"), "sessionDir", "must be a directory path");
 return resolve(setting.startsWith("~/") ? join(homedir(), setting.slice(2)) : setting);
}
export function serviceSettings(agentDir: string) {
 const file = join(agentDir, "settings.json"), base = arcSettings(file);
 sessionDirectory(agentDir);
 const block = (piSettings(file).ampi_arc ?? {}) as Record<string, unknown>;
 const { concurrency = 8, sourceVerifyBytesPerMinute = 64_000_000, sourceVerifyIntervalMs = 1_800_000 } = block;
 if (!Number.isSafeInteger(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 256) throw settingsError(file, "ampi_arc.concurrency", "must be an integer from 1 to 256");
 for (const [key, value] of Object.entries({ sourceVerifyBytesPerMinute, sourceVerifyIntervalMs })) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw settingsError(file, `ampi_arc.${key}`, "must be a positive safe integer");
 }
 return { ...base, concurrency: Number(concurrency), sourceVerifyBytesPerMinute: Number(sourceVerifyBytesPerMinute), sourceVerifyIntervalMs: Number(sourceVerifyIntervalMs) };
}
// The five-minute no-hub grace replaced this key. Startup names it once instead of failing.
export function ignoredIdleHours(agentDir: string): boolean {
 return Object.hasOwn((piSettings(join(agentDir, "settings.json")).ampi_arc ?? {}) as object, "serviceIdleHours");
}
