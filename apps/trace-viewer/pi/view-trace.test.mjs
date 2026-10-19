import test from "node:test";
import assert from "node:assert/strict";
import viewTraceExtension, { traceViewerUrl } from "./view-trace.mjs";

test("view-trace encodes an exact Session ID as one route segment", () => {
  assert.equal(
    traceViewerUrl("session/with spaces", "http://127.0.0.1:4319"),
    "http://127.0.0.1:4319/session/session%2Fwith%20spaces",
  );
  assert.equal(
    traceViewerUrl("session-1", "http://127.0.0.1:4319"),
    "http://127.0.0.1:4319/session/session-1",
  );
});

test("view-trace rejects an absent Session identity and path-normalizing IDs", () => {
  assert.throws(() => traceViewerUrl("   "), /current Session ID/);
  assert.throws(() => traceViewerUrl(""), /current Session ID/);
  assert.throws(() => traceViewerUrl("."), /current Session ID/);
  assert.throws(() => traceViewerUrl(".."), /current Session ID/);
  assert.throws(() => traceViewerUrl(undefined), /current Session ID/);
});

test("view-trace accepts only a bare allowlisted loopback HTTP origin", () => {
  assert.equal(
    traceViewerUrl("session-1", "http://live.pi.localhost:4319/"),
    "http://live.pi.localhost:4319/session/session-1",
  );
  assert.throws(() => traceViewerUrl("session-1", "https://127.0.0.1:4319"), /allowlisted/);
  assert.throws(() => traceViewerUrl("session-1", "http://example.test:4319"), /allowlisted/);
  assert.throws(
    () => traceViewerUrl("session-1", "http://user:pass@127.0.0.1:4319"),
    /allowlisted/,
  );
  assert.throws(() => traceViewerUrl("session-1", "http://127.0.0.1:4319/other"), /allowlisted/);
  assert.throws(() => traceViewerUrl("session-1", "http://127.0.0.1:4319/?stale=1"), /allowlisted/);
});

function registeredCommand(exec) {
  let command;
  const notifications = [];
  const opened = [];
  const pi = {
    exec: async (file, args) => {
      opened.push([file, ...args]);
      return exec ? exec(file, args) : { code: 0 };
    },
    registerCommand: (name, definition) => (command = { name, ...definition }),
  };
  viewTraceExtension(pi);
  const ctx = (sessionId) => ({
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  });
  return { command, notifications, opened, ctx };
}

test("view-trace opens the browser for the current Session", async () => {
  const { command, notifications, opened, ctx } = registeredCommand();

  await command.handler([], ctx("session-1"));

  assert.equal(opened.length, 1);
  assert.equal(opened[0].at(-1), "http://127.0.0.1:4319/session/session-1");
  assert.equal(notifications.at(-1).level, "info");
  assert.match(notifications.at(-1).message, /session-1/);
});

test("view-trace reports a missing Session instead of opening a browser", async () => {
  const { command, notifications, opened, ctx } = registeredCommand();

  await command.handler([], ctx(""));

  assert.equal(opened.length, 0);
  assert.equal(notifications.at(-1).level, "error");
  assert.match(notifications.at(-1).message, /current Session ID/);
});

test("view-trace reports a browser launch failure with a copyable URL", async () => {
  const { command, notifications, ctx } = registeredCommand(() => ({
    code: 1,
    stderr: "no browser",
  }));

  await command.handler([], ctx("session-1"));

  assert.equal(notifications.at(-1).level, "error");
  assert.match(notifications.at(-1).message, /http:\/\/127\.0\.0\.1:4319\/session\/session-1/);
});

test("view-trace reports a thrown browser launch as a copyable URL", async () => {
  const { command, notifications, ctx } = registeredCommand(() => {
    throw new Error("spawn failed");
  });

  await command.handler([], ctx("session-1"));

  assert.equal(notifications.at(-1).level, "error");
  assert.match(notifications.at(-1).message, /session-1/);
});
