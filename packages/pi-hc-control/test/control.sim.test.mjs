// Real Pi SDK (pi-sim): admission evidence, ordering, compaction and C1 holds,
// abort, status, and descriptor lifecycle. pi-sim forbids sockets, so the
// transport is replaced by a recorder; descriptor files are real.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SimWorld } from "@hypercarrier/pi-sim";
import { socketPathFor } from "../src/endpoint.mjs";
import { createHcControlExtension } from "../src/extension.mjs";

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, limit = 2000) {
  for (let i = 0; !predicate(); i++) {
    assert.ok(i < limit, `timed out waiting for ${label}`);
    await tick();
  }
}

async function scenario(options, body) {
  const transport = { listens: [], closes: 0 };
  const probe = {};
  const world = await SimWorld.create({
    seed: 11,
    settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } },
    ...options,
    extensionFactories: [
      createHcControlExtension({
        ...options.control,
        listen: async (path, handle) => {
          transport.listens.push({ path, handle });
          return { close: async () => void transport.closes++ };
        },
      }),
      (pi) => {
        probe.pi = pi;
        // Another extension that swallows one input after ours has seen it.
        pi.on("input", (event) => (event.text === "SYN swallowed" ? { action: "handled" } : undefined));
      },
    ],
  });
  const ctl = (frame) => transport.listens.at(-1).handle(frame);
  try {
    await body({ world, ctl, transport, probe });
    world.assertHealthy();
  } finally {
    await world.close();
  }
}

const userTexts = (world) =>
  world.sessionManager
    .getEntries()
    .filter((e) => e.type === "message" && e.message.role === "user")
    .map((e) => e.message.content.map((b) => b.text).join(""));

test("submit while idle starts a turn and cites the user entry", async () => {
  await scenario({ replies: [{ text: "synthetic reply", delayMs: 20 }] }, async ({ world, ctl }) => {
    const before = await world.run(() => ctl({ id: 1, op: "status" }));
    assert.equal(before.value.idle, true);
    const reply = await world.run(() => ctl({ id: 1, op: "submit", text: "SYN idle input", deliverAs: "followUp" }));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.evidence, "started");
    const entry = world.sessionManager.getEntry(reply.entryId);
    assert.equal(entry.message.role, "user");
    assert.equal(entry.message.content[0].text, "SYN idle input");
    await world.run(() => world.session.waitForIdle());
    assert.deepEqual(userTexts(world), ["SYN idle input"]);
  });
});

test("submit while streaming queues steer and followUp in Pi's order", async () => {
  await scenario(
    { replies: [{ text: "first", delayMs: 1000 }, { text: "after steer" }, { text: "after follow-up" }] },
    async ({ world, ctl }) => {
      await world.run(async () => {
        const run = world.session.prompt("SYN opening");
        await until(() => world.session.isStreaming, "streaming");
        const follow = await ctl({ id: "f", op: "submit", text: "SYN follow-up", deliverAs: "followUp" });
        const steer = await ctl({ id: "s", op: "submit", text: "SYN steer", deliverAs: "steer" });
        assert.deepEqual([follow.evidence, steer.evidence], ["admitted", "admitted"]);
        const status = await ctl({ id: "q", op: "status" });
        assert.equal(status.value.idle, false);
        assert.deepEqual(status.value.pending, { steer: 1, followUp: 1 });
        await run;
        await world.session.waitForIdle();
        const after = await ctl({ id: "q2", op: "status" });
        assert.deepEqual(after.value.pending, { steer: 0, followUp: 0 });
        assert.equal(after.value.idle, true);
        // Each admission names a submission; status follows it to delivery and cites the user entry.
        const delivered = Object.fromEntries(after.value.submissions.map((r) => [r.submission, r]));
        for (const [reply, text] of [[follow, "SYN follow-up"], [steer, "SYN steer"]]) {
          const record = delivered[reply.submission];
          assert.equal(record?.state, "delivered", JSON.stringify(after.value.submissions));
          assert.equal(world.sessionManager.getEntry(record.entryId).message.content[0].text, text);
        }
      });
      // Steer lands before the follow-up even though it was sent second.
      assert.deepEqual(userTexts(world), ["SYN opening", "SYN steer", "SYN follow-up"]);
    },
  );
});

test("submit during compaction waits, then starts after the summary", async () => {
  await scenario(
    {
      replies: [
        { text: "synthetic answer" },
        { text: "Synthetic summary of earlier work.", delayMs: 5000 },
        { text: "post-compaction reply" },
      ],
    },
    async ({ world, ctl }) => {
      await world.prompt("SYN before compaction");
      let compactedAt;
      await world.run(async () => {
        const compaction = world.session.compact().then(() => (compactedAt = Date.now()));
        await until(() => world.session.isCompacting, "compaction");
        const status = await ctl({ id: "c", op: "status" });
        assert.equal(status.value.compacting, true);
        const reply = await ctl({ id: "s", op: "submit", text: "SYN during compaction", deliverAs: "steer" });
        assert.equal(reply.ok, true, JSON.stringify(reply));
        assert.equal(reply.evidence, "started");
        await compaction;
        assert.ok(compactedAt);
        await world.session.waitForIdle();
      });
      const entries = world.sessionManager.getEntries();
      const compactionIndex = entries.findIndex((e) => e.type === "compaction");
      const userIndex = entries.findIndex((e) => e.message?.content?.[0]?.text === "SYN during compaction");
      assert.ok(compactionIndex >= 0 && userIndex > compactionIndex, "input enters only after compaction");
    },
  );
});

test("C1 delivery hold: submit waits for release, and times out as busy_compacting", async () => {
  await scenario(
    { replies: [{ text: "after release" }], control: { holdWaitMs: 120_000 } },
    async ({ world, ctl, probe }) => {
      const hold = (active) => probe.pi.events.emit("hc.delivery-hold", { holder: "sim-holder", token: "sim-1", active });
      await world.run(async () => {
        hold(true);
        const started = Date.now();
        const timedOut = await ctl({ id: "t", op: "submit", text: "SYN held input", deliverAs: "steer" });
        assert.equal(timedOut.ok, false);
        assert.equal(timedOut.error.code, "busy_compacting");
        assert.ok(Date.now() - started >= 120_000);
        assert.deepEqual(userTexts(world), [], "nothing was sent while held");

        setTimeout(() => hold(false), 5_000);
        const waitedFrom = Date.now();
        const reply = await ctl({ id: "r", op: "submit", text: "SYN released input", deliverAs: "steer" });
        assert.equal(reply.evidence, "started");
        assert.ok(Date.now() - waitedFrom >= 5_000);
        await world.session.waitForIdle();
      });
      assert.deepEqual(userTexts(world), ["SYN released input"]);
    },
  );
});

test("abort while streaming aborts; abort while idle reports idle", async () => {
  await scenario({ replies: [{ text: "never finishes", delayMs: 60_000 }] }, async ({ world, ctl }) => {
    await world.run(async () => {
      const run = world.session.prompt("SYN long task");
      await until(() => world.session.isStreaming, "streaming");
      const reply = await ctl({ id: "a", op: "abort" });
      assert.deepEqual(reply, { id: "a", ok: true, evidence: "aborted" });
      assert.equal(world.session.isIdle, true);
      await run.catch(() => {});
      assert.deepEqual(await ctl({ id: "b", op: "abort" }), { id: "b", ok: true, evidence: "idle" });
    });
  });
});

test("abort names queued submissions Pi returned to the editor draft, and ones it dropped", async () => {
  let draft = "";
  const uiContext = { getEditorText: () => draft, setEditorText: (text) => void (draft = text) };
  for (const [editor, expected] of [[true, "returned"], [false, "dropped"]])
    await scenario({ replies: [{ text: "never finishes", delayMs: 60_000 }], uiContext }, async ({ world, ctl }) => {
      draft = "";
      await world.run(async () => {
        const run = world.session.prompt("SYN long task");
        await until(() => world.session.isStreaming, "streaming");
        const follow = await ctl({ id: "f", op: "submit", text: "SYN queued one", deliverAs: "followUp" });
        const steer = await ctl({ id: "s", op: "submit", text: "SYN queued two", deliverAs: "steer" });
        const queued = (await ctl({ id: "q", op: "status" })).value.submissions;
        assert.deepEqual(queued.map((r) => [r.submission, r.state]), [[follow.submission, "queued"], [steer.submission, "queued"]]);
        // What Pi's interactive abort does before it aborts: the queue moves into the editor draft.
        const { steering, followUp } = world.session.clearQueue();
        if (editor) draft = [...steering, ...followUp].join("\n\n");
        const reply = await ctl({ id: "a", op: "abort" });
        assert.equal(reply.evidence, "aborted");
        assert.deepEqual(reply.submissions.map((r) => [r.submission, r.state, r.deliverAs, r.text]), [
          [follow.submission, expected, "followUp", "SYN queued one"],
          [steer.submission, expected, "steer", "SYN queued two"],
        ]);
        await run.catch(() => {});
        const after = (await ctl({ id: "q2", op: "status" })).value;
        assert.deepEqual(after.submissions.map((r) => r.state), [expected, expected]);
      });
      assert.deepEqual(userTexts(world), ["SYN long task"], "nothing queued was delivered");
    });
});

test("input Pi never admits is reported as not_admitted, idle or streaming", async () => {
  await scenario(
    { replies: [{ text: "busy", delayMs: 1000 }], control: { admitTimeoutMs: 5_000 } },
    async ({ world, ctl }) => {
      await world.run(async () => {
        const idle = await ctl({ id: "i", op: "submit", text: "SYN swallowed", deliverAs: "steer" });
        assert.equal(idle.error?.code, "not_admitted", JSON.stringify(idle));
        const run = world.session.prompt("SYN opening");
        await until(() => world.session.isStreaming, "streaming");
        const busy = await ctl({ id: "b", op: "submit", text: "SYN swallowed", deliverAs: "steer" });
        assert.equal(busy.error?.code, "not_admitted", JSON.stringify(busy));
        await run;
        await world.session.waitForIdle();
      });
      assert.deepEqual(userTexts(world), ["SYN opening"]);
    },
  );
});

test("invalid frames are rejected without touching the Session", async () => {
  await scenario({ replies: [] }, async ({ world, ctl }) => {
    const replies = await world.run(() =>
      Promise.all([
        ctl({ op: "status" }),
        ctl({ id: 1, op: "nope" }),
        ctl({ id: 2, op: "submit", text: "SYN", deliverAs: "later" }),
        ctl({ id: 3, op: "submit", text: "", deliverAs: "steer" }),
        ctl({ id: 4, op: "submit", text: "x".repeat(1024 * 1024 + 1), deliverAs: "steer" }),
        ctl({ id: 5, op: "submit", text: 7, deliverAs: "steer" }),
      ]),
    );
    assert.deepEqual(
      replies.map((r) => r.error.code),
      ["bad_request", "unknown_op", "bad_request", "bad_request", "too_large", "bad_request"],
    );
    assert.equal(replies[0].id, null);
    assert.deepEqual(userTexts(world), []);
  });
});

test("descriptor names the live Session; shutdown removes it and closes the socket", async () => {
  await scenario({ replies: [] }, async ({ world, ctl, transport }) => {
    const sessionId = world.sessionManager.getSessionId();
    const path = join(world.agentDir, "hc-control", `${sessionId}.json`);
    const descriptor = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(descriptor.schema, "hc-control/1");
    assert.equal(descriptor.sessionId, sessionId);
    assert.equal(descriptor.pid, process.pid);
    assert.match(descriptor.nonce, /^[0-9a-f]{32}$/);
    assert.equal(descriptor.version, "0.1.0");
    assert.equal(descriptor.socket, transport.listens[0].path);
    // The path rule itself, preferred or fallback, is endpoint.test.mjs's subject.
    assert.equal(transport.listens[0].path, socketPathFor(join(world.agentDir, "hc-control"), sessionId).path);
    const status = await world.run(() => ctl({ id: 1, op: "status" }));
    assert.equal(status.value.nonce, descriptor.nonce);
    assert.equal(status.value.sessionId, sessionId);

    await world.run(() => world.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
    assert.equal(existsSync(path), false);
    assert.equal(transport.closes, 1);
    const late = await world.run(() => ctl({ id: 2, op: "status" }));
    assert.equal(late.error.code, "closed");
  });
});
