import "../../test/home.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSourceWatcher } from "../watcher.js";

test("source watcher debounces file writes and closes its watchers", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-watch-"));
  let notify;
  let closed = false;
  const watchImpl = (_root, options, callback) => {
    assert.equal(options.recursive, true);
    notify = callback;
    const watcher = new EventEmitter();
    watcher.close = () => {
      closed = true;
    };
    return watcher;
  };
  const events = [];
  const watcher = createSourceWatcher((event) => events.push(event), {
    roots: [root],
    debounceMs: 5,
    watchImpl,
  });
  notify("change", "project/session.jsonl");
  notify("change", "project/session.jsonl");
  notify("rename", "project/other.jsonl");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "filesystem");
  assert.deepEqual(events[0].paths, [
    join(root, "project/other.jsonl"),
    join(root, "project/session.jsonl"),
  ].sort());
  watcher.close();
  assert.equal(closed, true);
});
