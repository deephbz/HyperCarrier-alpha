import assert from "node:assert/strict";
import test from "node:test";

import {
  createHerdrActivityReporter,
  herdrActivityTokens,
} from "../src/herdr-activity.mjs";

const activity = {
  latestUser: { timestamp: "2026-07-26T12:00:00.000Z" },
  latestAgentStop: { timestamp: "2026-07-26T10:58:00.000Z" },
};

test("Herdr activity tokens are wall-clock projections and reject unknown times", () => {
  assert.deepEqual(
    herdrActivityTokens(activity, Date.parse("2026-07-26T12:03:30.000Z")),
    {
      rarebit_user_age: "3m",
      rarebit_stop_age: "1h 05m",
    },
  );
  assert.deepEqual(
    herdrActivityTokens(
      {
        latestUser: { timestamp: "not-a-time" },
        latestAgentStop: { timestamp: null },
      },
      Date.parse("2026-07-26T12:03:30.000Z"),
    ),
    { rarebit_user_age: null, rarebit_stop_age: null },
  );
});

test("Herdr activity tokens show days and whole hours after 24 hours", () => {
  assert.deepEqual(
    herdrActivityTokens(
      {
        latestUser: { timestamp: "2026-07-25T12:00:00.000Z" },
        latestAgentStop: { timestamp: "2026-07-23T04:01:00.000Z" },
      },
      Date.parse("2026-07-26T12:00:00.000Z"),
    ),
    {
      rarebit_user_age: "1d 0h",
      rarebit_stop_age: "3d 7h",
    },
  );
});

test("Herdr reporter refreshes with TTL, applies only to Pi, and clears on shutdown", async () => {
  const sent = [];
  let scheduled;
  let cleared;
  const reporter = createHerdrActivityReporter({
    env: {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "p1",
    },
    now: () => Date.parse("2026-07-26T12:03:30.000Z"),
    send: async (_endpoint, request) => sent.push(request),
    setIntervalFn: (callback, interval) => {
      scheduled = { callback, interval, unref: () => {} };
      return scheduled;
    },
    clearIntervalFn: (timer) => {
      cleared = timer;
    },
  });

  reporter.start(activity);
  await Promise.resolve();
  assert.equal(scheduled.interval, 30_000);
  assert.deepEqual(sent[0].params, {
    pane_id: "p1",
    source: "rarebit:activity",
    applies_to_source: "herdr:pi",
    seq: sent[0].params.seq,
    ttl_ms: 90_000,
    tokens: { rarebit_user_age: "3m", rarebit_stop_age: "1h 05m" },
  });

  scheduled.callback();
  await Promise.resolve();
  assert.equal(sent.length, 2);
  reporter.stop();
  await Promise.resolve();
  assert.equal(cleared, scheduled);
  assert.deepEqual(sent.at(-1).params.tokens, {
    rarebit_user_age: null,
    rarebit_stop_age: null,
  });
});
