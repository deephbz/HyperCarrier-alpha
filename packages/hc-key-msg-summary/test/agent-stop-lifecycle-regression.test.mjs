import assert from "node:assert/strict";
import test from "node:test";

import { selectKeyMessages } from "../src/index.mjs";
import {
  createDetachedMaterializer,
  registerKeyMessageSummaryLifecycle,
} from "../src/lifecycle.mjs";

const waitFor = async (predicate, message = "condition was not reached") => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
};

function harness(branch) {
  const handlers = new Map();
  const pi = { on: (event, handler) => handlers.set(event, handler) };
  const ctx = {
    cwd: "/synthetic/project",
    sessionId: "synthetic-session",
    sessionManager: {
      getHeader: () => ({ id: "synthetic-session" }),
      getBranch: () => branch,
      getSessionFile: () => "/synthetic/session.jsonl",
    },
  };
  return { ctx, handlers, pi };
}

function userMessage(text = "Inspect the synthetic result.") {
  return {
    type: "message",
    id: "user-request",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
}

function assistantMessage(stopReason, text, id) {
  return {
    type: "message",
    id,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      stopReason,
      content: [{ type: "text", text }],
    },
  };
}

test("normal agent stop schedules a second full-branch materialization after the user snapshot", () => {
  const branch = [];
  const scheduled = [];
  const { ctx, handlers, pi } = harness(branch);
  registerKeyMessageSummaryLifecycle(pi, (snapshot) => scheduled.push(snapshot));

  handlers.get("session_start")({}, ctx);
  scheduled.length = 0;

  const user = userMessage();
  handlers.get("input")({ source: "interactive", text: user.message.content[0].text }, ctx);
  branch.push(user);
  handlers.get("message_end")({ message: user.message }, ctx);
  handlers.get("before_provider_request")({}, ctx);

  assert.equal(scheduled.length, 1);
  assert.deepEqual(
    selectKeyMessages(scheduled[0].sessionManager.getBranch()).occurrences.map(({ outcome }) => outcome),
    ["user"],
  );

  branch.push(assistantMessage("toolUse", "Intermediate continuation.", "continuation"));
  const final = assistantMessage("stop", "Synthetic work completed.", "final-stop");
  branch.push(final);
  const returned = handlers.get("agent_end")({ messages: [user.message, final.message] }, ctx);

  assert.equal(returned, undefined, "the lifecycle hook must remain detached");
  assert.equal(scheduled.length, 1, "agent_end must not project before Pi fully settles");
  handlers.get("agent_settled")({}, ctx);
  assert.equal(scheduled.length, 2, "normal settlement must refresh the earlier user-only materialization");
  assert.deepEqual(
    selectKeyMessages(scheduled[1].sessionManager.getBranch()).occurrences.map(({ outcome }) => outcome),
    ["user", "continuation", "stop"],
  );
});

test("aborted and nonterminal agent_end events do not masquerade as final agent stops", () => {
  for (const [label, terminal] of [
    ["aborted", assistantMessage("aborted", "Interrupted partial output.", "aborted")],
    ["tool-only", assistantMessage("toolUse", "Still waiting for a tool result.", "tool-use")],
  ]) {
    const branch = [userMessage(), terminal];
    const scheduled = [];
    const { ctx, handlers, pi } = harness(branch);
    registerKeyMessageSummaryLifecycle(pi, (snapshot) => scheduled.push(snapshot));
    handlers.get("session_start")({}, ctx);
    scheduled.length = 0;

    handlers.get("agent_end")({ messages: [terminal.message] }, ctx);
    handlers.get("agent_settled")({}, ctx);
    assert.equal(scheduled.length, 0, `${label} settlement must not schedule materialization`);
  }
});

test("agent-stop refresh stays detached and safely follows an in-flight user materialization", async () => {
  const branch = [];
  const started = [];
  const finishes = [];
  const materialize = async (snapshot) => {
    started.push(selectKeyMessages(snapshot.sessionManager.getBranch()).occurrences.map(({ outcome }) => outcome));
    await new Promise((resolve) => finishes.push(resolve));
  };
  const schedule = createDetachedMaterializer(materialize);
  const { ctx, handlers, pi } = harness(branch);
  registerKeyMessageSummaryLifecycle(pi, schedule);

  handlers.get("session_start")({}, ctx);
  await waitFor(() => started.length === 1, "bootstrap materialization did not start");
  finishes.shift()();
  await waitFor(() => finishes.length === 0, "bootstrap materialization did not settle");

  const user = userMessage();
  handlers.get("input")({ source: "interactive", text: user.message.content[0].text }, ctx);
  branch.push(user);
  handlers.get("message_end")({ message: user.message }, ctx);
  handlers.get("before_provider_request")({}, ctx);
  await waitFor(() => started.length === 2, "user materialization did not start");

  const final = assistantMessage("stop", "Detached synthetic completion.", "detached-final");
  branch.push(final);
  const returned = handlers.get("agent_end")({ messages: [final.message] }, ctx);
  assert.equal(returned, undefined);
  assert.equal(started.length, 2, "agent_end must not overlap the in-flight run");
  handlers.get("agent_settled")({}, ctx);

  finishes.shift()();
  await waitFor(() => started.length === 3, "queued final-stop refresh did not run");
  assert.deepEqual(started[1], ["user"]);
  assert.deepEqual(started[2], ["user", "stop"]);
  finishes.shift()();
});

test("an intermediate agent_end before queued continuation is never projected early", () => {
  const branch = [userMessage()];
  const scheduled = [];
  const { ctx, handlers, pi } = harness(branch);
  registerKeyMessageSummaryLifecycle(pi, (snapshot) => scheduled.push(snapshot));
  handlers.get("session_start")({}, ctx);
  scheduled.length = 0;

  const intermediate = assistantMessage("stop", "Intermediate run stop.", "intermediate-stop");
  branch.push(intermediate);
  handlers.get("agent_end")({ messages: [intermediate.message] }, ctx);
  assert.equal(scheduled.length, 0);

  handlers.get("agent_start")({}, ctx);
  const final = assistantMessage("stop", "Final continuation report.", "final-continuation-stop");
  branch.push(final);
  handlers.get("agent_end")({ messages: [final.message] }, ctx);
  assert.equal(scheduled.length, 0);
  handlers.get("agent_settled")({}, ctx);

  assert.equal(scheduled.length, 1);
  assert.deepEqual(
    selectKeyMessages(scheduled[0].sessionManager.getBranch()).occurrences.map(({ text }) => text),
    ["Inspect the synthetic result.", "Intermediate run stop.", "Final continuation report."],
  );
});

test("settled materialization crosses compaction without treating its summary as a Key Message", () => {
  const beforeUser = userMessage("Preserve the pre-compaction owner intent.");
  const beforeStop = assistantMessage(
    "stop",
    "Preserve the pre-compaction finding.",
    "pre-compaction-stop",
  );
  const compaction = {
    type: "compaction",
    id: "synthetic-compaction",
    parentId: "pre-compaction-stop",
    timestamp: "2026-01-01T00:00:02.000Z",
    summary: "Machine-generated compaction prose is not conversation authority.",
  };
  const afterUser = {
    ...userMessage("Preserve the post-compaction steer."),
    id: "post-compaction-user",
    timestamp: "2026-01-01T00:00:03.000Z",
  };
  const afterStop = {
    ...assistantMessage("stop", "Preserve the post-compaction result.", "post-compaction-stop"),
    timestamp: "2026-01-01T00:00:04.000Z",
  };
  const branch = [beforeUser, beforeStop, compaction, afterUser, afterStop];
  const scheduled = [];
  const { ctx, handlers, pi } = harness(branch);
  registerKeyMessageSummaryLifecycle(pi, (snapshot) => scheduled.push(snapshot));
  handlers.get("session_start")({}, ctx);
  scheduled.length = 0;

  handlers.get("agent_end")({ messages: [afterUser.message, afterStop.message] }, ctx);
  assert.equal(scheduled.length, 0);
  handlers.get("agent_settled")({}, ctx);

  assert.equal(scheduled.length, 1);
  const capturedBranch = scheduled[0].sessionManager.getBranch();
  assert.equal(capturedBranch.length, 5, "the raw root-to-leaf path must cross the compaction entry");
  assert.equal(capturedBranch[2].type, "compaction");
  const selection = selectKeyMessages(capturedBranch);
  assert.deepEqual(
    selection.occurrences.map(({ outcome, text }) => ({ outcome, text })),
    [
      { outcome: "user", text: "Preserve the pre-compaction owner intent." },
      { outcome: "stop", text: "Preserve the pre-compaction finding." },
      { outcome: "user", text: "Preserve the post-compaction steer." },
      { outcome: "stop", text: "Preserve the post-compaction result." },
    ],
  );
  assert.equal(
    selection.occurrences.some(({ text }) => text.includes("Machine-generated compaction prose")),
    false,
  );
});
