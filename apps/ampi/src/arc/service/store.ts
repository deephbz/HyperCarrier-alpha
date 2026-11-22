// Durable writes and engine selection share the service lifetime lock.
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ServiceLock } from "./lock.ts";
import { compare, validStamp, type Stamp } from "./engine.ts";
import schema from "./schema.json" with { type: "json" };
export const STORE_SCHEMA = schema.store;

export interface ControlState { selected?: Stamp }

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
export function readJson(path: string): unknown {
 try { return JSON.parse(readFileSync(path, "utf8")); }
 catch (error) { if (missing(error)) return undefined; throw error; }
}
// Publish a complete identity exclusively. A deleted store must never inherit
// the admission rights of a launcher from its previous incarnation.
export function storeIncarnation(store: string, create = false): string | null {
 const path = join(store, "incarnation.json");
 try {
  const read = () => {
   const value = readJson(path) as { id?: unknown } | undefined;
   if (value === undefined) return null;
   if (typeof value?.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id)) throw new Error("Invalid store incarnation");
   return value.id;
  };
  const current = read();
  if (current || !create) return current;
  const temp = path + "." + randomUUID() + ".tmp";
  try {
   writeFileSync(temp, JSON.stringify({ id: randomUUID() }), { flag: "wx", mode: 0o600 });
   // link is exclusive like O_EXCL, and readers never see a partially written UUID.
   try { linkSync(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { rmSync(temp, { force: true }); }
  return read();
 } catch (error) {
  throw new Error(`Cannot read or initialize Arc store identity ${path}. Stop all AmPi processes on this Host, restore or remove this file, then restart AmPi.`, { cause: error });
 }
}
export type StopState = { generation: string; recovery?: { generation: string; state: "pending" }; uncertainty?: "unknown-prior-stop" };
export function readStop(store: string): StopState | undefined {
 const value = readJson(join(store, "stop.json")) as StopState | undefined;
 if (value === undefined) return;
 if (!value || typeof value !== "object" || typeof value.generation !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.generation) ||
     value.recovery !== undefined && (!value.recovery || value.recovery.state !== "pending" || value.recovery.generation !== value.generation) ||
     value.uncertainty !== undefined && value.uncertainty !== "unknown-prior-stop") throw Object.assign(new Error("Invalid Arc stop obligation"), { code: "invalid-stop" });
 return value;
}
export function fenceStop(lock: ServiceLock, forced = false): StopState {
 let prior: StopState | undefined, corrupt = false;
 try { prior = readStop(lock.store); }
 catch (error) { if (!(error instanceof SyntaxError) && (error as { code?: string }).code !== "invalid-stop") throw error; corrupt = true; }
 // A locked child's stderr is service.log: the trace outlives the one result that reports it.
 if (corrupt) console.error(`${new Date().toISOString()} Arc stop: the record of an earlier stop is unreadable. Its signals are unknown; it may have interrupted a Build and charged a model call. AmPi cancels the queued Builds before Arc runs again.`);
 const generation = randomUUID(), pending = forced || corrupt || Boolean(prior?.recovery);
 // Uncertainty lives only while its cancellation is pending. The completing
 // stop reports it once; service.log keeps the durable trace.
 const uncertainty = corrupt ? "unknown-prior-stop" as const : prior?.recovery ? prior.uncertainty : undefined;
 const next: StopState = { generation, ...(pending ? { recovery: { generation, state: "pending" as const } } : {}), ...(uncertainty ? { uncertainty } : {}) };
 try { durableJson(lock, "stop.json", next); }
 catch (error) { throw Object.assign(error as Error, { recoveryUncertainty: uncertainty }); }
 return next;
}
export function completeRecovery(lock: ServiceLock, generation: string): void {
 const stop = readStop(lock.store);
 if (!stop?.recovery || stop.generation !== generation) throw new Error("The stop record changed during cancellation");
 durableJson(lock, "stop.json", { generation });
}

export function durableJson(lock: ServiceLock, name: string, value: unknown): void {
 lock.assertHeld();
 if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) throw new Error("Invalid Arc store filename");
 const target = join(lock.store, name), temporary = target + "." + randomUUID() + ".tmp";
 let fd: number | undefined;
 try {
  fd = openSync(temporary, "wx", 0o600);
  writeFileSync(fd, JSON.stringify(value) + "\n");
  fsyncSync(fd); closeSync(fd); fd = undefined;
  renameSync(temporary, target);
  fd = openSync(lock.store, "r");
  fsyncSync(fd); closeSync(fd); fd = undefined;
 } finally {
  if (fd !== undefined) closeSync(fd);
  rmSync(temporary, { force: true });
 }
}

export function controlStore(lock: ServiceLock) {
 function read(): ControlState {
  lock.assertHeld();
  const value = readJson(join(lock.store, "control.json")) as ControlState | undefined;
  if (value?.selected && !validStamp(value.selected)) throw new Error("Invalid Arc engine selection");
  return value?.selected ? { selected: value.selected } : {};
 }
 return {
  read,
  select(offered: Stamp): Stamp {
   if (!validStamp(offered)) throw new Error("Invalid Arc engine offering");
   const current = read().selected;
   if (current && compare(offered, current) !== "newer") return current;
   durableJson(lock, "control.json", { selected: offered });
   return offered;
  },
 };
}
