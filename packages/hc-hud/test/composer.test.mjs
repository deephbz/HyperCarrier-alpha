import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createComposer, sessionStats } from "../src/composer.mjs";
import { createSlotStore, SLOT_EVENT, COMPOSER_EVENT } from "../src/contract.mjs";

const slot = (over = {}) => ({ v: 1, key: "context.budget", producer: "hc-auto-compact", asOf: 1,
  value: { kind: "ratio", used: 133100, limit: 200000, unit: "tokens", mode: "auto", threshold: 90 }, ...over });
function harness(mode = "tui") {
  const emitter = new EventEmitter(), trace = [], notifications = [];
  const events = { emit: (...args) => emitter.emit(...args), on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn); } };
  let footer, entries = [], reads = 0, leaf = "leaf";
  const ctx = { mode, cwd: "/workspace/项目", model: { provider: "p", id: "claude-fable-5-1", contextWindow: 1000000 },
    getContextUsage: () => ({ tokens: 440000, contextWindow: 1000000 }),
    sessionManager: { getSessionId: () => "session", getLeafId: () => leaf, getEntryCount: () => entries.length,
      getEntries() { reads++; return entries; }, getCwd: () => ctx.cwd, getSessionName: () => "test" },
    ui: { notify: (...args) => notifications.push(args), setFooter(factory) {
      trace.push(factory ? "set" : "clear"); footer?.dispose();
      footer = factory?.({ requestRender() { trace.push("render"); } }, { fg: (_tone, text) => text }, {
        getGitBranch: () => "main", getExtensionStatuses: () => new Map([["other", "other ready"]]),
        onBranchChange: () => () => trace.push("unbranch"),
      });
    } },
  };
  return { pi: { events, getThinkingLevel: () => "medium" }, ctx, trace, notifications,
    get footer() { return footer; }, get reads() { return reads; },
    append(entry) { entries.push(entry); }, branch() { leaf = "new"; }, emitter };
}
test("presence order, synchronous replay, late discovery, Session clearing, shutdown and reload", () => {
  const h = harness();
  let fallback = true;
  h.pi.events.on(COMPOSER_EVENT, ({ present, surface }) => {
    assert.equal(surface, "tui-footer");
    h.trace.push(`present:${present}`); fallback = !present;
    if (present) h.pi.events.emit(SLOT_EVENT, slot());
  });
  const composer = createComposer(h.pi, { env: {} });
  composer.start(h.ctx);
  assert.ok(h.trace.indexOf("present:true") < h.trace.indexOf("set"));
  assert.equal(fallback, false);
  assert.equal(composer.store.slots.size, 1);
  let lateReplays = 0;
  h.pi.events.on(COMPOSER_EVENT, ({ present }) => {
    if (present) { lateReplays++; h.pi.events.emit(SLOT_EVENT, slot({ key: "late.label", producer: "late", value: { kind: "label", text: "late" } })); }
  });
  // A late producer may have installed a fallback before discovering presence.
  h.ctx.ui.setFooter(() => ({ dispose() {}, render: () => ["late fallback"] }));
  h.pi.events.emit(SLOT_EVENT, slot({ key: "late.label", producer: "late", value: { kind: "label", text: "late" } }));
  assert.match(h.footer.render(120)[1], /67%\/200k/);
  assert.equal(lateReplays, 1);
  assert.equal(composer.store.slots.size, 2);
  h.pi.events.emit(SLOT_EVENT, slot({ key: "old.label", producer: "old", value: { kind: "label", text: "old Session" } }));
  composer.start(h.ctx);
  assert.equal(composer.store.slots.has("old.label"), false);
  assert.match(h.footer.render(120)[1], /67%\/200k/);
  assert.equal(h.footer.render(120)[2], "other ready");
  composer.shutdown();
  assert.ok(h.trace.lastIndexOf("clear") < h.trace.lastIndexOf("present:false"));
  assert.equal(fallback, true);
  const next = createComposer(h.pi, { env: {} });
  next.start(h.ctx);
  assert.equal(fallback, false);
  assert.equal(next.store.slots.size, 2);
  next.shutdown();
  assert.equal(h.emitter.listenerCount(SLOT_EVENT), 0);
});
test("staleness requests a redraw while idle", async () => {
  const h = harness(), composer = createComposer(h.pi);
  composer.start(h.ctx);
  h.pi.events.emit(SLOT_EVENT, slot({ key: "decaying.label", producer: "decaying", asOf: Date.now(), staleAfterMs: 15, value: { kind: "label", text: "old" } }));
  const before = h.trace.filter((value) => value === "render").length;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(h.trace.filter((value) => value === "render").length > before);
  assert.match(h.footer.render(120)[1], /old\?/);
  composer.shutdown();
});
test("RPC does not claim the TUI surface", () => {
  const h = harness("rpc");
  h.pi.events.on(COMPOSER_EVENT, () => assert.fail("RPC claimed a footer"));
  const composer = createComposer(h.pi);
  composer.start(h.ctx); composer.shutdown();
  assert.deepEqual(h.trace, []);
});
test("stats include all Pi usage paths and cache hit uses latest assistant", () => {
  const usage = (cost, input = 1, cacheRead = 0, cacheWrite = 0) => ({ input, cacheRead, cacheWrite, cost: { total: cost } });
  const entries = [
    { type: "usage", usage: usage(1) },
    { type: "message", message: { role: "assistant", usage: usage(2, 1, 99) } },
    { type: "message", message: { role: "toolResult", usage: usage(3, 50, 50) } },
    { type: "compaction", usage: usage(4) }, { type: "branch_summary", usage: usage(5) },
    { type: "message", message: { role: "assistant", usage: usage(6, 10, 80, 10) } },
    { type: "message", message: { role: "user", usage: usage(100) } },
  ];
  assert.deepEqual(sessionStats(entries), { cost: 21, cacheHit: 80 });
  assert.equal(sessionStats([...entries, { type: "message", message: { role: "assistant", usage: usage(0, 0, 0, 0) } }]).cacheHit, undefined);
});
test("stats cache refreshes on append, branch, and invalidation", () => {
  const h = harness(), composer = createComposer(h.pi);
  composer.start(h.ctx);
  h.footer.render(120); h.footer.render(120);
  assert.equal(h.reads, 1);
  h.append({ type: "usage", usage: { cost: { total: 2 } } });
  assert.match(h.footer.render(120)[1], /\$2.00/); assert.equal(h.reads, 2);
  h.branch(); h.footer.render(120); assert.equal(h.reads, 3);
  h.footer.invalidate(); h.footer.render(120); assert.equal(h.reads, 4);
  composer.setTier("minimal"); assert.doesNotMatch(h.footer.render(120)[1], /\$/);
  composer.shutdown();
});
test("slot ownership survives retraction, warns once, rejects old and invalid inputs", () => {
  const warnings = [], store = createSlotStore({ warn: (message) => warnings.push(message) });
  assert.equal(store.accept(slot()), true);
  assert.equal(store.accept(slot({ producer: "other" })), false);
  assert.equal(store.accept(slot({ producer: "other", value: null })), false);
  assert.equal(warnings.length, 1);
  assert.equal(store.accept(slot({ value: null, asOf: 2 })), true);
  assert.equal(store.accept(slot({ producer: "other", asOf: 3 })), false);
  assert.equal(store.accept(slot()), false);
  for (const value of [NaN, Infinity, -1]) assert.equal(store.accept(slot({ value: { kind: "ratio", used: value, limit: 1, unit: "tokens" } })), false);
  assert.equal(store.accept(slot({ value: { kind: "ratio", used: 1, limit: 0, unit: "tokens" } })), false);
  assert.equal(store.accept(slot({ key: "ansi.label", value: { kind: "label", text: "\x1b[31mred" } })), false);
  assert.equal(store.accept(slot({ v: 2 })), false);
  store.clear(); assert.equal(store.accept(slot({ producer: "other" })), true);
  const original = slot({ key: "stale.ratio", staleAfterMs: 10 });
  store.accept(original); original.value.used = 0;
  assert.equal(store.dump(12).find((s) => s.key === "stale.ratio").value.used, 133100);
  assert.equal(store.dump(12).find((s) => s.key === "stale.ratio").stale, true);
});
