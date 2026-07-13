import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSourceWatcher } from "../watcher.js";

test("source watcher debounces related writes into one refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-watch-"));
  mkdirSync(join(root, "nested"));
  let callback;
  let closed = false;
  const watchImpl = (_root, options, cb) => {
    assert.equal(options.recursive, true);
    callback = cb;
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
  callback("change", "nested/session.jsonl");
  callback("change", "nested/session.jsonl");
  callback("rename", "nested/other.jsonl");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "filesystem");
  assert.deepEqual(
    events[0].paths,
    [join(root, "nested/other.jsonl"), join(root, "nested/session.jsonl")].sort(),
  );
  watcher.close();
  assert.equal(closed, true);
});
