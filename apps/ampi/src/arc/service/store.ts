// Durable writes and engine selection share the service lifetime lock.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
