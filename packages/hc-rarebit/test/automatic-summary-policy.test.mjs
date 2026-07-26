import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import registerPiRarebit from "../src/extension.mjs";
import {
  RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
  RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT,
  queryAutomaticSummaryPolicy,
} from "../src/automatic-summary-policy.mjs";
import { processRarebitSummary } from "../src/rarebit-service.mjs";
import { rarebitMaterializationPath } from "../src/rarebit-store.mjs";

function eventBus() {
  const handlers = new Map();
  return {
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () =>
        handlers.set(
          channel,
          list.filter((item) => item !== handler),
        );
    },
    emit(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };
}

function respond(query, overrides = {}) {
  const observedAt = new Date();
  query.respond({
    contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
    queryId: query.queryId,
    decision: "inhibit",
    provider: "test-team-policy",
    reason: "current_teammate_membership",
    observedAt: observedAt.toISOString(),
    validUntil: new Date(observedAt.getTime() + 1_000).toISOString(),
    provenance: {
      identity: "team_opaque",
      generation: "membership_opaque",
      association: "session_opaque",
    },
    ...overrides,
  });
}

const session = {
  sessionId: "session-1",
  durableAssociation: "/tmp/session-1.jsonl",
};

test("policy query fails open for absent, thrown, late, malformed, incompatible, stale, and conflicting providers", async (t) => {
  const cases = [
    ["absent", () => eventBus(), "provider_absent"],
    [
      "thrown",
      () => ({
        emit() {
          throw new Error("provider failure");
        },
      }),
      "provider_failure",
    ],
    [
      "late",
      () => {
        const bus = eventBus();
        bus.on(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT, (query) =>
          setTimeout(() => respond(query), 25),
        );
        return bus;
      },
      "provider_absent",
    ],
    [
      "malformed",
      () => {
        const bus = eventBus();
        bus.on(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT, (query) =>
          query.respond({ decision: "inhibit" }),
        );
        return bus;
      },
      "invalid_response",
    ],
    [
      "incompatible",
      () => {
        const bus = eventBus();
        bus.on(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT, (query) =>
          respond(query, { contractVersion: "future/2" }),
        );
        return bus;
      },
      "invalid_response",
    ],
    [
      "stale",
      () => {
        const bus = eventBus();
        bus.on(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT, (query) =>
          respond(query, {
            observedAt: "2020-01-01T00:00:00.000Z",
            validUntil: "2020-01-01T00:00:01.000Z",
          }),
        );
        return bus;
      },
      "invalid_response",
    ],
    [
      "conflict",
      () => {
        const bus = eventBus();
        bus.on(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT, (query) => {
          respond(query);
          respond(query, {
            provider: "other-policy",
            provenance: {
              identity: "other",
              generation: "other",
              association: "other",
            },
          });
        });
        return bus;
      },
      "conflict",
    ],
  ];
  for (const [name, createBus, queryStatus] of cases) {
    await t.test(name, async () => {
      const result = await queryAutomaticSummaryPolicy(createBus(), session, {
        timeoutMs: 10,
      });
      assert.equal(result.decision, "abstain");
      assert.equal(result.queryStatus, queryStatus);
    });
  }
});

test("one fresh inhibition remains valid beside abstaining providers", async () => {
  const bus = eventBus();
  bus.on(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT, (query) => {
    const observedAt = new Date();
    query.respond({
      contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
      queryId: query.queryId,
      decision: "abstain",
      provider: "unrelated-policy",
      reason: "not_applicable",
      observedAt: observedAt.toISOString(),
      validUntil: new Date(observedAt.getTime() + 1_000).toISOString(),
    });
  });
  bus.on(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT, respond);
  const result = await queryAutomaticSummaryPolicy(bus, session, {
    timeoutMs: 10,
  });
  assert.equal(result.decision, "inhibit");
  assert.equal(result.provider, "test-team-policy");
});

test("an inhibition that expires during response collection fails open", async () => {
  const bus = eventBus();
  bus.on(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT, (query) => {
    query.respond({
      contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
      queryId: query.queryId,
      decision: "inhibit",
      provider: "test-team-policy",
      reason: "current_teammate_membership",
      observedAt: new Date(1_000).toISOString(),
      validUntil: new Date(1_005).toISOString(),
      provenance: {
        identity: "team_opaque",
        generation: "membership_opaque",
        association: "session_opaque",
      },
    });
  });
  const times = [1_000, 1_001, 1_011];
  const result = await queryAutomaticSummaryPolicy(bus, session, {
    timeoutMs: 10,
    now: () => times.shift() ?? 1_011,
  });
  assert.equal(result.decision, "abstain");
  assert.equal(result.queryStatus, "stale_response");
});

function eligibleBranch() {
  return [
    {
      type: "message",
      id: "owner",
      message: { role: "user", content: "owner evidence" },
    },
  ];
}

async function serviceFixture(name) {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  const sessionRoot = join(root, "sessions");
  await mkdir(sessionRoot);
  const sessionFile = join(sessionRoot, "session.jsonl");
  await writeFile(sessionFile, "{}\n");
  return {
    root,
    sessionRoot,
    sessionFile,
    ctx: {
      sessionManager: {
        getHeader: () => ({ id: name }),
        getSessionFile: () => sessionFile,
        getBranch: () => eligibleBranch(),
      },
    },
  };
}

function inhibition(queryId = "policy-query") {
  const observedAt = new Date();
  return {
    contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
    queryId,
    decision: "inhibit",
    queryStatus: "inhibited",
    provider: "pi-teams",
    reason: "current_teammate_membership",
    observedAt: observedAt.toISOString(),
    validUntil: new Date(observedAt.getTime() + 1_000).toISOString(),
    queriedAt: observedAt.toISOString(),
    provenance: {
      identity: "team_hash",
      generation: "membership_hash",
      association: "session_hash",
    },
  };
}

test("only an exact current inhibition prevents automatic model work and persists a distinct receipt", async () => {
  const fixture = await serviceFixture("inhibition-receipt");
  let modelCalls = 0;
  let queryCalls = 0;
  const common = {
    sessionRoot: fixture.sessionRoot,
    rarebitRoot: join(fixture.root, "rarebit"),
    summaryPolicy: { minTotalLength: 0, maxRarebitRatio: 1 },
    model: { provider: "test", id: "cheap" },
    modelClient: {
      complete: async () => {
        modelCalls += 1;
        return {
          text: JSON.stringify({
            summary:
              "Progress: done | Findings: exact | Questions/Requests: none | Next step: inspect",
            sessionStatus: "finished",
            statusReason: "all_requests_accomplished",
          }),
        };
      },
    },
  };
  const inhibited = await processRarebitSummary(fixture.ctx, {
    ...common,
    queryAutomaticSummaryPolicy: async () => {
      queryCalls += 1;
      return inhibition();
    },
  });
  assert.equal(inhibited.record.status, "inhibited");
  assert.equal("eligibility" in inhibited.record, false);
  assert.equal(inhibited.record.automaticSummaryPolicy.provider, "pi-teams");
  assert.equal(modelCalls, 0);
  assert.equal(queryCalls, 1);

  const repeatedGeneration = await processRarebitSummary(fixture.ctx, {
    ...common,
    queryAutomaticSummaryPolicy: async () => inhibition("policy-query-2"),
  });
  assert.equal(repeatedGeneration.duplicate, true);
  assert.equal(repeatedGeneration.record.jobId, inhibited.record.jobId);

  const replacementGeneration = await processRarebitSummary(fixture.ctx, {
    ...common,
    queryAutomaticSummaryPolicy: async () => ({
      ...inhibition("policy-query-3"),
      provenance: {
        identity: "team_hash",
        generation: "replacement_membership_hash",
        association: "session_hash",
      },
    }),
  });
  assert.equal(replacementGeneration.record.status, "inhibited");
  assert.notEqual(replacementGeneration.record.jobId, inhibited.record.jobId);
  assert.equal(modelCalls, 0);

  const laterUnbound = await processRarebitSummary(fixture.ctx, {
    ...common,
    queryAutomaticSummaryPolicy: async () => ({
      contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
      decision: "abstain",
      queryStatus: "provider_abstained",
    }),
  });
  assert.equal(laterUnbound.record.status, "ok");
  assert.notEqual(laterUnbound.record.jobId, inhibited.record.jobId);
  assert.equal(modelCalls, 1);
});

test("injected incomplete or stale inhibitions fail open at the service boundary", async (t) => {
  for (const [name, mutate] of [
    [
      "missing correlation and timestamps",
      (value) => {
        delete value.queryId;
        delete value.observedAt;
        delete value.validUntil;
        delete value.queriedAt;
      },
    ],
    [
      "expired after query completion",
      (value) => {
        value.observedAt = "2020-01-01T00:00:00.000Z";
        value.queriedAt = "2020-01-01T00:00:00.100Z";
        value.validUntil = "2020-01-01T00:00:01.000Z";
      },
    ],
  ]) {
    await t.test(name, async () => {
      const fixture = await serviceFixture(
        `invalid-inhibition-${name.replaceAll(" ", "-")}`,
      );
      let modelCalls = 0;
      const injected = inhibition();
      mutate(injected);
      const result = await processRarebitSummary(fixture.ctx, {
        sessionRoot: fixture.sessionRoot,
        rarebitRoot: join(fixture.root, "rarebit"),
        summaryPolicy: { minTotalLength: 0, maxRarebitRatio: 1 },
        model: { provider: "test", id: "cheap" },
        modelClient: {
          complete: async () => {
            modelCalls += 1;
            return {
              text: JSON.stringify({
                summary:
                  "Progress: synthesized | Findings: fail open | Questions/Requests: none | Next step: inspect",
                sessionStatus: "finished",
                statusReason: "all_requests_accomplished",
              }),
            };
          },
        },
        queryAutomaticSummaryPolicy: async () => injected,
      });
      assert.equal(result.record.status, "ok");
      assert.equal(modelCalls, 1);
      assert.equal("automaticSummaryPolicy" in result.record, false);
    });
  }
});

test("intrinsic ineligibility and manual force bypass the external policy query", async () => {
  const fixture = await serviceFixture("force-bypass");
  let modelCalls = 0;
  let queryCalls = 0;
  const common = {
    sessionRoot: fixture.sessionRoot,
    rarebitRoot: join(fixture.root, "rarebit"),
    model: { provider: "test", id: "cheap" },
    modelClient: {
      complete: async () => {
        modelCalls += 1;
        return {
          text: JSON.stringify({
            summary:
              "Progress: manual | Findings: works | Questions/Requests: none | Next step: inspect",
            sessionStatus: "finished",
            statusReason: "all_requests_accomplished",
          }),
        };
      },
    },
    queryAutomaticSummaryPolicy: async () => {
      queryCalls += 1;
      return inhibition();
    },
  };
  const ineligible = await processRarebitSummary(fixture.ctx, common);
  const forced = await processRarebitSummary(fixture.ctx, {
    ...common,
    forceSynthesis: true,
  });
  assert.equal(ineligible.record.status, "ineligible");
  assert.equal(forced.record.status, "ok");
  assert.equal(forced.record.synthesisMode, "forced");
  assert.equal(queryCalls, 0);
  assert.equal(modelCalls, 1);
});

test("both extension load orders inhibit lifecycle synthesis and status reports the narrow policy", async (t) => {
  for (const order of ["provider-first", "rarebit-first"]) {
    await t.test(order, async () => {
      const fixture = await serviceFixture(`load-order-${order}`);
      const bus = eventBus();
      const handlers = new Map();
      const commands = new Map();
      const notices = [];
      let modelCalls = 0;
      const pi = {
        events: bus,
        on: (event, handler) => handlers.set(event, handler),
        registerCommand: (name, command) => commands.set(name, command),
      };
      const registerProvider = () =>
        bus.on(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT, respond);
      if (order === "provider-first") registerProvider();
      registerPiRarebit(pi, {
        automaticSummaryPolicyTimeoutMs: 10,
        sessionRoot: fixture.sessionRoot,
        rarebitRoot: join(fixture.root, "rarebit"),
        summaryPolicy: { minTotalLength: 0, maxRarebitRatio: 1 },
        model: { provider: "test", id: "cheap" },
        modelClient: {
          complete: async () => {
            modelCalls += 1;
            return { text: "must not run" };
          },
        },
      });
      if (order === "rarebit-first") registerProvider();
      const ctx = {
        ...fixture.ctx,
        hasUI: true,
        ui: { notify: (text) => notices.push(text) },
        cwd: fixture.root,
        isProjectTrusted: () => true,
      };
      handlers.get("session_start")({}, ctx);
      handlers.get("input")({ source: "interactive", text: "trigger" }, ctx);
      handlers.get("message_end")(
        { message: { role: "user", content: "trigger" } },
        ctx,
      );
      handlers.get("before_provider_request")({}, ctx);
      const path = rarebitMaterializationPath(fixture.sessionFile, {
        sessionRoot: fixture.sessionRoot,
        rarebitRoot: join(fixture.root, "rarebit"),
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          if ((await readFile(path, "utf8")).includes('"status":"inhibited"'))
            break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.match(await readFile(path, "utf8"), /"status":"inhibited"/);
      assert.equal(modelCalls, 0);
      await commands.get("rarebit").handler("status", ctx);
      assert.match(
        notices.at(-1),
        /automatic summary inhibited by team-management policy/,
      );
    });
  }
});
