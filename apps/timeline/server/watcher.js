import { existsSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultWatchRoots(home = homedir()) {
  const agent = join(home, ".pi", "agent");
  return [
    join(agent, "sessions"),
    join(agent, "timeline", "events"),
    join(agent, "timeline", "live"),
    join(home, ".pi", "teams"),
  ];
}

export function createSourceWatcher(
  onChange,
  { roots = defaultWatchRoots(), debounceMs = 75, watchImpl = watch } = {},
) {
  const watchers = [];
  let timer;
  let closed = false;
  const pending = new Set();

  const flush = () => {
    timer = undefined;
    if (closed || pending.size === 0) return;
    const paths = [...pending].sort();
    pending.clear();
    onChange({ reason: "filesystem", paths });
  };
  const enqueue = (root, filename) => {
    pending.add(filename ? join(root, String(filename)) : root);
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  };

  for (const root of roots.filter(existsSync)) {
    try {
      const watcher = watchImpl(root, { recursive: true, persistent: false }, (_event, filename) =>
        enqueue(root, filename),
      );
      watcher.on?.("error", () => {});
      watchers.push(watcher);
    } catch {
      // A slow reconciliation remains active when a platform cannot watch a root.
    }
  }

  return {
    roots: roots.filter(existsSync),
    close() {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
