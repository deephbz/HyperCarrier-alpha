// Private verification facts and a durable rolling-minute native-read budget.
// Reservation precedes I/O. An unknown outcome stays charged until its window expires.
import { randomUUID } from "node:crypto";
export type SourceStamp = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
export type SourceVerificationState = {
 schema: 1;
 charges: { id: string; at: number; bytes: number }[];
 sources: Record<string, { sessionRef: string; verifiedVersion?: string; verifiedAt?: number; verifiedStamp?: SourceStamp; observedStamp?: SourceStamp; repairPending?: boolean; overdueLoggedAt?: number }>;
};
export type VerificationSettings = { bytesPerMinute: number; intervalMs: number };
export const sourceStamp = ({ dev, ino, size, mtimeMs, ctimeMs }: SourceStamp): SourceStamp => ({ dev, ino, size, mtimeMs, ctimeMs });
export const stampKey = (s?: SourceStamp) => s && `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export function sourceVerification(options: {
 now(): number; settings(): VerificationSettings;
 persistence?: { load(): unknown; save(state: SourceVerificationState): void };
}) {
 let fault: unknown;
 const settings = () => {
  const value = options.settings();
  if (!Number.isSafeInteger(value.bytesPerMinute) || value.bytesPerMinute < 1 || !Number.isSafeInteger(value.intervalMs) || value.intervalMs < 1) throw new Error("Invalid source verification settings");
  return value;
 };
 function valid(value: any): value is SourceVerificationState {
  const stamp = (s: any) => s === undefined || s && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => typeof s[key] === "number" && Number.isFinite(s[key]));
  return value?.schema === 1 && Array.isArray(value.charges) && value.charges.every((c: any) => typeof c.id === "string" && Number.isFinite(c.at) && Number.isSafeInteger(c.bytes) && c.bytes >= 0) && value.sources && !Array.isArray(value.sources) && typeof value.sources === "object" && Object.entries(value.sources).every(([key, s]: [string, any]) => /^[a-f0-9]{64}$/.test(key) && typeof s?.sessionRef === "string" && (s.verifiedVersion === undefined || typeof s.verifiedVersion === "string") && (s.verifiedAt === undefined || Number.isFinite(s.verifiedAt)) && stamp(s.verifiedStamp) && stamp(s.observedStamp) && (s.repairPending === undefined || typeof s.repairPending === "boolean"));
 }
 let loaded: unknown;
 try { loaded = options.persistence?.load(); } catch { loaded = null; }
 const state: SourceVerificationState = valid(loaded) ? structuredClone(loaded) : {
  schema: 1, sources: {}, charges: loaded === undefined ? [] : [{ id: randomUUID(), at: options.now(), bytes: settings().bytesPerMinute }],
 };
 Object.setPrototypeOf(state.sources, null);
 function save() {
  if (fault) throw fault;
  try { options.persistence?.save(structuredClone(state)); } catch (error) { fault = error; throw error; }
 }
 function available() {
  if (fault) return 0;
  const now = options.now();
  return Math.max(0, settings().bytesPerMinute - state.charges.filter(c => c.at > now - 60000).reduce((sum, c) => sum + c.bytes, 0));
 }
 return {
  state, save, settings, available,
  get fault() { return fault; },
  reserve() {
   if (fault) throw fault;
   const now = options.now();
   state.charges = state.charges.filter(c => c.at > now - 60000);
   const bytes = Math.min(65536, available());
   if (!bytes) return;
   const charge = { id: randomUUID(), at: now, bytes };
   state.charges.push(charge); save();
   return charge;
  },
  reconcile(charge: { id: string; bytes: number }, actual: number) {
   if (!Number.isSafeInteger(actual) || actual < 0 || actual > charge.bytes) throw new Error("Invalid verification read accounting");
   const saved = state.charges.find(c => c.id === charge.id);
   if (!saved) throw new Error("Missing verification reservation");
   saved.bytes = actual; save();
  },
 };
}

// A bounded single-flight driver. Each quantum yields a real event-loop turn.
export function verificationPump(options: { active(): boolean; step(): Promise<boolean> }) {
 let running: Promise<void> | undefined;
 return { run() {
  return running ??= (async () => {
   for (let quantum = 0; quantum < 64 && options.active(); quantum++) {
    if (!await options.step()) break;
    await new Promise<void>(resolve => setImmediate(resolve));
   }
  })().finally(() => { running = undefined; });
 } };
}
