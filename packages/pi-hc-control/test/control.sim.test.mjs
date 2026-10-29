// Real Pi SDK (pi-sim): admission evidence, ordering, compaction and C1 holds,
// abort, status, typed slash commands, and descriptor lifecycle. pi-sim forbids sockets, so the
// transport is replaced by a recorder; descriptor files are real.
import "./home.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
      ...(options.extraFactories ?? []),
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

// A second, reasoning-capable model so /model has somewhere to go.
const altModels = {
  async setup({ modelRuntime, model }) {
    const alt = (id, reasoning) => ({ ...model, id, name: id, reasoning, provider: undefined, compat: undefined });
    modelRuntime.registerProvider("sim-alt", {
      baseUrl: model.baseUrl,
      api: model.api,
      apiKey: "synthetic-not-a-credential",
      models: [alt("sim-alt-model", true), alt("sim-model", false)],
    });
    await modelRuntime.setRuntimeApiKey("sim-alt", "synthetic-not-a-credential");
  },
};
const entriesOf = (world, type) => world.sessionManager.getEntries().filter((e) => e.type === type);

test("command /model changes the model and adds no user entry", async () => {
  await scenario({ replies: [{ text: "on the new model" }], ...altModels }, async ({ world, ctl }) => {
    const status = await world.run(() => ctl({ id: "s", op: "status" }));
    assert.equal(status.value.commands, 1, "status advertises the commands capability");
    const listed = await world.run(() => ctl({ id: "l", op: "commands" }));
    assert.ok(listed.value.models.some((m) => m.ref === "sim-alt/sim-alt-model"), JSON.stringify(listed.value.models));
    assert.equal(listed.value.model, "sim-provider/sim-model");
    const reply = await world.run(() => ctl({ id: "m", op: "command", name: "model", args: "sim-alt-model" }));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.disposition, "handled");
    assert.equal(reply.effect.model, "sim-alt/sim-alt-model");
    assert.match(reply.notice, /^Model: sim-alt\/sim-alt-model/);
    assert.equal(world.session.model.id, "sim-alt-model");
    assert.equal(entriesOf(world, "model_change").at(-1).modelId, "sim-alt-model");
    assert.deepEqual(userTexts(world), [], "no /model user message");
    await world.prompt("SYN after switch");
    assert.equal(world.requests.at(-1).body.model, "sim-alt-model");
  });
});

test("command /model rejects an ambiguous bare id and an unknown ref, naming the matches", async () => {
  await scenario({ replies: [], ...altModels }, async ({ world, ctl }) => {
    const changes = entriesOf(world, "model_change").length;
    const [ambiguous, missing, bare] = await world.run(() =>
      Promise.all([
        ctl({ id: 1, op: "command", name: "model", args: "sim-model" }),
        ctl({ id: 2, op: "command", name: "model", args: "nope/none" }),
        ctl({ id: 3, op: "command", name: "model", args: "" }),
      ]),
    );
    assert.equal(ambiguous.error.code, "bad_args");
    assert.deepEqual(ambiguous.error.matches, ["sim-provider/sim-model", "sim-alt/sim-model"]);
    assert.equal(missing.error.code, "bad_args");
    assert.equal(bare.error.code, "bad_args");
    assert.equal(world.session.model.provider, "sim-provider");
    assert.equal(entriesOf(world, "model_change").length, changes);
  });
});

test("command /thinking reports the clamped level; /name sets the Session name", async () => {
  await scenario({ replies: [], ...altModels }, async ({ world, ctl }) => {
    const clamped = await world.run(() => ctl({ id: 1, op: "command", name: "thinking", args: "high" }));
    assert.equal(clamped.disposition, "handled", JSON.stringify(clamped));
    assert.deepEqual(clamped.effect, { thinking: "off", requested: "high", changed: false });
    assert.equal(clamped.notice, "Thinking: off (high is not available for this model)");
    await world.run(() => ctl({ id: 2, op: "command", name: "model", args: "sim-alt/sim-alt-model" }));
    const set = await world.run(() => ctl({ id: 3, op: "command", name: "thinking", args: "high" }));
    assert.deepEqual(set.effect, { thinking: "high", requested: "high", changed: true });
    const bad = await world.run(() => ctl({ id: 4, op: "command", name: "thinking", args: "max" }));
    assert.equal(bad.error.code, "bad_args");
    const named = await world.run(() => ctl({ id: 5, op: "command", name: "name", args: "SYN title" }));
    assert.equal(named.notice, "Name: SYN title");
    assert.equal(world.sessionManager.getSessionName(), "SYN title");
    assert.deepEqual(userTexts(world), []);
  });
});

test("unknown, unsupported and stale commands send nothing to Pi", async () => {
  const extraFactories = [
    (pi) => {
      pi.registerCommand("syn-gone", { description: "removed later", handler: async () => {} });
    },
  ];
  await scenario({ replies: [], extraFactories }, async ({ world, ctl }) => {
    const listed = await world.run(() => ctl({ id: "l", op: "commands" }));
    const byName = Object.fromEntries(listed.value.commands.map((c) => [c.name, c]));
    assert.equal(byName["syn-gone"].source, "extension");
    assert.equal(byName.model.source, "builtin");
    assert.equal(byName.reload.supported, false);
    // Stale list: the command left Pi after the client read it (side review 1).
    for (const extension of world.session.extensionRunner.extensions) extension.commands.delete("syn-gone");
    const replies = await world.run(() =>
      Promise.all([
        ctl({ id: 1, op: "command", name: "zzz" }),
        ctl({ id: 2, op: "command", name: "reload" }),
        ctl({ id: 3, op: "command", name: "syn-gone" }),
        ctl({ id: 4, op: "command", name: "/model", args: "x" }),
      ]),
    );
    assert.deepEqual(
      replies.map((r) => r.error?.code),
      ["unknown_command", "unsupported_command", "unknown_command", "bad_request"],
    );
    assert.match(replies[1].error.message, /only in the Pi pane/);
    assert.deepEqual(userTexts(world), []);
    assert.equal(world.requests.length, 0);
  });
});

test("an extension command is dispatched at once, even while busy, and never claims success", async () => {
  const ran = [];
  const extraFactories = [
    (pi) => {
      pi.registerCommand("syn-ok", { handler: async (args) => void ran.push(["ok", args]) });
      pi.registerCommand("syn-throws", {
        handler: async () => {
          ran.push(["throws"]);
          throw new Error("synthetic handler failure");
        },
      });
    },
  ];
  await scenario({ replies: [{ text: "long", delayMs: 1000 }], extraFactories }, async ({ world, ctl }) => {
    await world.run(async () => {
      const run = world.session.prompt("SYN opening");
      await until(() => world.session.isStreaming, "streaming");
      const ok = await ctl({ id: 1, op: "command", name: "syn-ok", args: "a b" });
      const thrown = await ctl({ id: 2, op: "command", name: "syn-throws" });
      for (const reply of [ok, thrown]) {
        assert.equal(reply.disposition, "dispatched", JSON.stringify(reply));
        assert.match(reply.notice, /result and errors show in the Pi pane/);
        assert.equal(reply.evidence, undefined);
      }
      await until(() => ran.length === 2, "handlers");
      assert.deepEqual(ran, [["ok", "a b"], ["throws"]]);
      assert.equal(world.session.isStreaming, true, "the command did not wait for the turn");
      await run;
      await world.session.waitForIdle();
    });
    assert.deepEqual(userTexts(world), ["SYN opening"]);
    // The failure reaches only Pi's own error path; the control reply could not know it.
    const failure = (e) => e.kind === "extension.error" && e.data.error === "synthetic handler failure";
    assert.equal(world.history.filter(failure).length, 1);
    world.history = world.history.filter((e) => !failure(e));
  });
});

test("a prompt template starts or queues as its expanded text; a queued one never settles as dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hcc-tpl-"));
  const template = join(dir, "syn-tpl.md");
  writeFileSync(template, "Expanded synthetic template: $1\n");
  const extraFactories = [(pi) => pi.on("resources_discover", () => ({ promptPaths: [template] }))];
  const replies = [{ text: "first" }, { text: "long", delayMs: 800 }, { text: "after" }];
  try {
    await scenario({ replies, extraFactories }, async ({ world, ctl }) => {
      const listed = await world.run(() => ctl({ id: "l", op: "commands" }));
      assert.equal(listed.value.commands.find((c) => c.name === "syn-tpl")?.source, "prompt", JSON.stringify(listed.value.commands));
      const idle = await world.run(() => ctl({ id: 1, op: "command", name: "syn-tpl", args: "alpha" }));
      assert.equal(idle.disposition, "started", JSON.stringify(idle));
      const entry = world.sessionManager.getEntries().find((e) => e.id === idle.entryId);
      assert.match(entry.message.content.map((b) => b.text).join(""), /^Expanded synthetic template: alpha/);
      await world.run(() => world.session.waitForIdle());
      let queued;
      await world.run(async () => {
        const run = world.session.prompt("SYN long");
        await until(() => world.session.isStreaming, "streaming");
        queued = await ctl({ id: 2, op: "command", name: "syn-tpl", args: "beta", deliverAs: "followUp" });
        await run;
        await world.session.waitForIdle();
      });
      assert.equal(queued.disposition, "queued", JSON.stringify(queued));
      const status = await world.run(() => ctl({ id: "s", op: "status" }));
      const record = status.value.submissions.find((r) => r.submission === queued.submission);
      assert.equal(record?.expanded, true, JSON.stringify(status.value.submissions));
      assert.ok(["delivered", "unknown"].includes(record.state), `queued expansion settled as ${record.state}`);
      assert.ok(userTexts(world).some((t) => t.startsWith("Expanded synthetic template: beta")), JSON.stringify(userTexts(world)));
      assert.ok(!userTexts(world).some((t) => t.startsWith("/syn-tpl")), "no raw /syn-tpl user message");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command /compact while busy is refused unless abort is explicit; a repeated key runs once", async () => {
  await scenario(
    { replies: [{ text: "short" }, { text: "long", delayMs: 60_000 }, { text: "Synthetic summary." }] },
    async ({ world, ctl }) => {
      await world.prompt("SYN first turn").catch(() => {});
      await world.run(async () => {
        const run = world.session.prompt("SYN long task");
        await until(() => world.session.isStreaming, "streaming");
        const refused = await ctl({ id: 1, op: "command", name: "compact" });
        assert.equal(refused.error?.code, "busy", JSON.stringify(refused));
        assert.match(refused.error.message, /stops the running turn/);
        assert.equal(world.session.isStreaming, true, "the turn still runs");
        const first = await ctl({ id: 2, op: "command", name: "compact", abort: true, key: "k1" });
        assert.equal(first.disposition, "handled", JSON.stringify(first));
        assert.equal(first.evidence, "compaction_started");
        const again = await ctl({ id: 3, op: "command", name: "compact", abort: true, key: "k1" });
        assert.deepEqual({ ...again, id: 2 }, first);
        assert.equal(again.id, 3);
        await run.catch(() => {});
        await until(() => entriesOf(world, "compaction").length === 1 && world.session.isIdle, "compaction", 20_000);
      });
      assert.equal(entriesOf(world, "compaction").length, 1, "the repeated key did not compact twice");
    },
  );
});
