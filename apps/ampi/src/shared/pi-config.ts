// Stamp-cached global Pi settings. A malformed file never silently selects a model.
import { readFileSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const piSettingsPath = () => join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
/** Watch the directory so atomic settings replacement keeps the trigger cache current. */
export function watchArcSettings(changed: (auto: boolean) => void): () => void {
 const file = piSettingsPath();
 const refresh = () => { try { changed(arcSettings(file).auto); } catch { /* the next Build reports invalid settings */ } };
 refresh();
 try { const watcher = watch(dirname(file), { persistent: false }, (_event, name) => { if (name === "settings.json") refresh(); }); watcher.on("error", () => {}); return () => watcher.close(); }
 catch { return () => {}; }
}
export const settingsError = (settingsPath: string, settingsKey: string, message: string) => Object.assign(new Error(`${settingsPath}: ${settingsKey}: ${message}`), { code: "settings", settingsPath, settingsKey });
const cache = new Map<string, { stamp: string; value: Record<string, unknown> }>();
export function piSettings(file = piSettingsPath()): Record<string, unknown> {
 let stamp: string;
 try { const s = statSync(file); stamp = `${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`; }
 catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
 const prior = cache.get(file); if (prior?.stamp === stamp) return prior.value;
 let value;
 try { value = JSON.parse(readFileSync(file, "utf8")); }
 catch { throw settingsError(file, "$", "settings must be valid JSON"); }
 if (!value || typeof value !== "object" || Array.isArray(value)) throw settingsError(file, "$", "settings must be an object");
 cache.set(file, { stamp, value }); return value;
}
export function arcSettings(file = piSettingsPath()): { model: string; auto: boolean; retries: number } {
  const block = piSettings(file).ampi_arc;
  if (block !== undefined && (!block || typeof block !== "object" || Array.isArray(block))) throw settingsError(file, "ampi_arc", "must be an object");
  const { model = "anthropic/claude-haiku-5-5", auto = true, retries = 2 } = (block ?? {}) as Record<string, unknown>;
  if (typeof model !== "string" || !/^[^\s/:]+\/[^\s:]+$/.test(model)) throw settingsError(file, "ampi_arc.model", "must be a full provider/modelId string");
  if (typeof auto !== "boolean") throw settingsError(file, "ampi_arc.auto", "must be a boolean");
  if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || retries > 5) throw settingsError(file, "ampi_arc.retries", "must be an integer from 0 to 5");
  return { model, auto, retries };
}
