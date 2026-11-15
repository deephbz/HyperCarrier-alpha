// Survivor inspection never kills a PID. A coarse or unavailable identity can
// retain capacity conservatively, but it cannot release a live matching child.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
const exec = promisify(execFile);
export type ProcessProbe = { kind: "found"; startedAt: string } | { kind: "gone" } | { kind: "unknown" };
export async function inspectProcess(pid: number): Promise<ProcessProbe> {
 if (!Number.isSafeInteger(pid) || pid < 2) return { kind: "unknown" };
 if (process.platform === "linux") {
  try {
   const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
   const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
   if (fields[0] === "Z" || fields[0] === "X") return { kind: "gone" };
   return /^\d+$/.test(fields[19] ?? "") && boot.trim() ? { kind: "found", startedAt: `linux:${boot.trim()}:${fields[19]}` } : { kind: "unknown" };
  } catch (e) { return ["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "") ? { kind: "gone" } : { kind: "unknown" }; }
 }
 if (process.platform !== "darwin") return { kind: "unknown" };
 try {
  const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "stat="], { timeout: 2000, env: { ...process.env, LC_ALL: "C" } });
  const parts = stdout.trim().split(/\s+/), state = parts.pop();
  if (!state || parts.length !== 5) return { kind: "unknown" };
  if (state.startsWith("Z")) return { kind: "gone" };
  return { kind: "found", startedAt: "darwin:" + parts.join(" ") };
 } catch {
  try { process.kill(pid, 0); return { kind: "unknown" }; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" ? { kind: "gone" } : { kind: "unknown" }; }
 }
}
