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
 const { concurrency = 8, serviceIdleHours = 24 } = block;
 if (!Number.isSafeInteger(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 256) throw settingsError(file, "ampi_arc.concurrency", "must be an integer from 1 to 256");
 if (typeof serviceIdleHours !== "number" || !Number.isFinite(serviceIdleHours) || serviceIdleHours <= 0) throw settingsError(file, "ampi_arc.serviceIdleHours", "must be positive");
 return { ...base, concurrency: Number(concurrency), serviceIdleHours };
}
