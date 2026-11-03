// This control's build stamp, for AmPi's one-build rule (apps/ampi P1). The rule is AmPi's
// (apps/ampi/src/shared/build.ts `controlStamp`): `id` hashes the `.ts` files under src/,
// `order` is the checkout's HEAD committer time, and `line` only names the line.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("./", import.meta.url));

/** A hash over the `.ts` files under `root`, with their paths from `/src/` on. */
function sourceHash(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts")) hash.update(path.slice(path.lastIndexOf("/src/"))).update(readFileSync(path));
    }
  };
  walk(root);
  return hash.digest("hex").slice(0, 12);
}

/**
 * `{ id, order, line }`, or null when the checkout has no git metadata. A null stamp fails
 * closed: AmPi refuses every control op and names both stamps.
 */
export function controlStamp(root = SRC): { id: string; order: number; line: string } | null {
  let order = 0;
  try {
    order = Number(execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {}
  if (!Number.isInteger(order) || order <= 0) return null;
  const line = existsSync(join(root, "../../../release/public/export-manifest.durable.json")) ? "durable" : "stable";
  return { id: sourceHash(root), order, line };
}
