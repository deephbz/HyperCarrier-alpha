import assert from "node:assert/strict";
import test from "node:test";

import registerPiRarebit from "../src/extension.mjs";

const user = {
  type: "message",
  id: "user-1",
  timestamp: "2026-07-26T12:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text: "Hello" }] },
};
const stop = {
  type: "message",
  id: "stop-1",
  timestamp: "2026-07-26T12:01:00.000Z",
  message: {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Done" }],
  },
};

test("Pi extension publishes recency only after native user/stop evidence persists", () => {
  const branch = [];
  const context = {
    sessionId: "session-1",
    sessionManager: {
      getHeader: () => ({ id: "session-1" }),
      getSessionFile: () => "/tmp/session-1.jsonl",
      getBranch: () => branch,
    },
  };
  const handlers = new Map();
  const reports = [];
  registerPiRarebit(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      activityReporter: {
        start: (activity) => reports.push(["start", activity]),
        update: (activity) => reports.push(["update", activity]),
        stop: () => reports.push(["stop"]),
      },
    },
  );

  handlers.get("session_start")({}, context);
  handlers.get("message_end")({ message: user.message }, context);
  assert.equal(reports.length, 1, "message_end precedes native append");

  branch.push(user);
  handlers.get("before_provider_request")({}, context);
  assert.deepEqual(reports.at(-1)[1].latestUser, {
    sourceEntryId: "user-1",
    timestamp: "2026-07-26T12:00:00.000Z",
  });
  assert.equal(reports.at(-1)[1].latestAgentStop, null);

  handlers.get("message_end")({ message: stop.message }, context);
  assert.equal(reports.length, 2, "assistant message_end does not read early");
  branch.push(stop);
  handlers.get("agent_end")({ messages: [stop.message] }, context);
  handlers.get("agent_settled")({}, context);
  assert.deepEqual(reports.at(-1)[1].latestAgentStop, {
    sourceEntryId: "stop-1",
    timestamp: "2026-07-26T12:01:00.000Z",
  });

  branch.pop();
  handlers.get("session_tree")({}, context);
  assert.equal(reports.at(-1)[1].latestAgentStop, null);
  handlers.get("session_shutdown")({}, context);
  assert.deepEqual(reports.at(-1), ["stop"]);
});
