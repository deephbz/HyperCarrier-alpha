// Self-update: reload this Pi Session when the package on disk is the build AmPi expects and not the loaded one.
// AmPi names its expected build in the status op (`expect`). Without it nothing happens, so a half-finished local
// edit never triggers a reload. Guards, in order: a quiet Session, the disk build, one try per (Session, build), no
// reason to wait for a restart, a checkout with no Git operation in progress, and two reads `stableMs` apart that agree.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlStamp } from "./stamp.ts";

type Stamp = { id: string; order: number; line: string };
type Attempt = { target: Stamp; reported: boolean };

const SRC = fileURLToPath(new URL("./", import.meta.url));
// A reload replaces this module but not the process: the record of each try must survive it.
const ATTEMPTS: Map<string, Attempt> = ((globalThis as any)[Symbol.for("hc-control.self-update")] ??= new Map());
// Each (Session, build) that waits for a restart, so its notice shows once.
const WAITS: Set<string> = ((globalThis as any)[Symbol.for("hc-control.self-update-waits")] ??= new Set());

/** The stamp inputs' mtimes and sizes, so an unchanged tree costs stats, not hashes and git. */
function inputsKey(src: string, gitDir: string | null): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (name.endsWith(".ts")) parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
    }
  };
  walk(src);
  if (gitDir) for (const file of ["HEAD", "logs/HEAD"]) try { parts.push(`${file}:${statSync(join(gitDir, file)).mtimeMs}`); } catch {}
  return parts.join("\n");
}

function gitDirOf(src: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: src, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * `loaded`: this build. `sessionId()`: the Session the record is kept for. `quiet()`: Pi is idle with nothing
 * queued or compacting. `reload(target)`: run the reload for `target`. `notify(text, level)`: one pane notice.
 * `gitDir`: the checkout's Git directory, or null for none; default: looked up from `src` at the first check.
 * `restartReason()`: why a reload would do harm, so the update waits for a Pi restart; null when none.
 */
export function createSelfUpdate({
  loaded,
  sessionId,
  quiet,
  reload,
  notify,
  src = SRC,
  readDisk = () => controlStamp(src),
  gitDir: knownGitDir,
  restartReason = () => null,
  quietMs = 30_000,
  stableMs = 2_000,
  jitterMs = 5_000,
  now = Date.now,
  random = Math.random,
}: {
  loaded: Stamp | null;
  sessionId: () => string | undefined;
  quiet: () => boolean;
  reload: (target: Stamp) => void;
  notify: (text: string, level: "info" | "warning") => void;
  src?: string;
  readDisk?: () => Stamp | null;
  gitDir?: string | null;
  restartReason?: () => string | null;
  quietMs?: number;
  stableMs?: number;
  jitterMs?: number;
  now?: () => number;
  random?: () => number;
}) {
  let expected: Stamp | null = null;
  let lastActivity = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  let stopped = false;
  let gitDir: string | null | undefined = knownGitDir;
  let cache: { key: string; stamp: Stamp | null } | undefined;

  const git = () => (gitDir === undefined ? (gitDir = gitDirOf(src)) : gitDir);
  const disk = () => {
    const key = inputsKey(src, git());
    if (cache?.key !== key) cache = { key, stamp: readDisk() };
    return cache.stamp;
  };
  const busyCheckout = () => {
    const dir = git();
    return !!dir && ["index.lock", "rebase-merge", "rebase-apply"].some((name) => existsSync(join(dir, name)));
  };
  const quietFor = () => quietMs - (now() - lastActivity);
  const schedule = (delayMs: number) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void check(), Math.max(0, delayMs));
    timer.unref?.();
  };
  // A check awaits this wait, so it keeps the event loop alive; only the scheduled check above is unref'd.
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Why this check did not reload, or "reloading"; tests read it. */
  async function check(): Promise<string> {
    if (stopped || checking) return "busy";
    checking = true;
    try {
      const id = sessionId();
      if (!expected || !loaded || !id) return "no_expected";
      if (!quiet()) return "not_quiet"; // the next settle schedules again
      if (quietFor() > 0) return (schedule(quietFor()), "not_quiet");
      const first = disk();
      if (!first || first.id !== expected.id || first.id === loaded.id) return "no_target";
      if (ATTEMPTS.get(id)?.target.id === first.id) return "tried";
      const why = restartReason();
      if (why) {
        const key = `${id}\0${first.id}`;
        if (!WAITS.has(key)) WAITS.add(key), notify(`HC control ${first.id} waits for a Pi restart: ${why}.`, "info");
        return "waits_for_restart";
      }
      if (busyCheckout()) return (schedule(stableMs), "checkout_busy");
      await sleep(stableMs);
      cache = undefined;
      const second = disk();
      if (second?.id !== first.id || busyCheckout()) return (schedule(stableMs), "unstable");
      if (stopped || !quiet() || quietFor() > 0) return "not_quiet";
      ATTEMPTS.set(id, { target: first, reported: false });
      reload(first);
      return "reloading";
    } finally {
      checking = false;
    }
  }

  return {
    check,
    /** AmPi's expected build, from a status op. An idle Session never settles, so this also schedules a check. */
    expect(stamp: unknown) {
      const value = stamp as Stamp | null;
      if (!value || typeof value.id !== "string") return;
      const changed = expected?.id !== value.id;
      expected = value;
      if (changed) schedule(Math.max(quietFor(), random() * jitterMs));
    },
    /** Any owner input or agent event: the quiet window starts again. */
    activity() {
      lastActivity = now();
    },
    settled() {
      lastActivity = now();
      if (expected) schedule(quietMs);
    },
    /** After a reload: report the try this Session made, once. */
    started() {
      const id = sessionId();
      const attempt = id ? ATTEMPTS.get(id) : undefined;
      if (!attempt || attempt.reported) return;
      attempt.reported = true;
      if (loaded?.id === attempt.target.id) notify(`HC control updated to ${loaded.id}; extensions reloaded`, "info");
      else notify(`HC control reloaded but still runs ${loaded?.id ?? "an unknown build"}, not ${attempt.target.id}. Restart this Pi Session.`, "warning");
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
