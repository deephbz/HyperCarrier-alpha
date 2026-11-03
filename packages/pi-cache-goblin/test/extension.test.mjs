import "./home.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createCacheGoblinExtension, EVENTS } from "../src/extension.mjs";

const user = (text) => ({ role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] });
const request = (text = "first") => ({ model: "claude-routed", max_tokens: 100,
  system: [{ type: "text", text: "rules\n<cwd>\n/work\n</cwd>" }], messages: [user(text)] });
function harness(options) {
  const handlers = new Map(), commands = new Map(), placed = [], notices = [], statuses = [];
  const entries = [];
  const pi = { events: new EventEmitter(), on: (name, fn) => handlers.set(name, fn), registerCommand: (name, cmd) => commands.set(name, cmd),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) };
  pi.events.on(EVENTS.placed, (data) => placed.push(data));
  createCacheGoblinExtension(options)(pi);
  const ctx = { model: { api: "openai-responses", id: "virtual" }, ui: {
    notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args),
  } };
  return { pi, placed, notices, statuses, ctx, entries,
    session: (id, list = entries) => (ctx.sessionManager = { getSessionId: () => id, getEntries: () => list }),
    run: (name, data) => handlers.get(name)(data, ctx),
    command: (arg) => commands.get("cache").handler(arg, ctx) };
}

test("routed Messages payload is handled independently of selected ctx.model", () => {
  const h = harness();
  const out = h.run("before_provider_request", { payload: request() });
  assert.equal(out.messages[0].content[0].cache_control.ttl, "5m");
  assert.equal(h.placed[0].model, "claude-routed");
  assert.deepEqual(h.run("cache_warming_decision", { action: "warm" }), { action: "stop" });
});

test("native 5m warming requires matching physical selection and declared 300s lifetime", () => {
  const h = harness();
  h.ctx.model = { api: "anthropic-messages", id: "claude-routed", promptCache: { short: 300 } };
  h.run("before_provider_request", { payload: request() });
  assert.equal(h.run("cache_warming_decision", { action: "warm" }), undefined);
  h.ctx.model.promptCache.short = 3600;
  h.run("before_provider_request", { payload: request() });
  assert.deepEqual(h.run("cache_warming_decision", { action: "warm" }), { action: "stop" });
});

test("unsupported route fails open without a placement claim", () => {
  const h = harness();
  h.ctx.model.api = "anthropic-messages";
  const payload = { model: "gpt-example", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };
  assert.equal(h.run("before_provider_request", { payload }), undefined);
  assert.equal(h.placed.length, 0);
  assert.deepEqual(h.run("cache_warming_decision", { action: "warm" }), { action: "stop" });
  assert.match(h.statuses.at(-1)[1], /policy not applied/);
});

test("one held pin replaces previous pin and rejects malformed names", () => {
  const h = harness();
  h.pi.events.emit(EVENTS.pin, { name: "old" });
  h.pi.events.emit(EVENTS.pin, { name: "new" });
  for (const name of [null, 3, {}, " "]) h.pi.events.emit(EVENTS.pin, { name });
  h.run("before_provider_request", { payload: request() });
  assert.deepEqual(h.placed.at(-1).pins.map((p) => p.name), ["new"]);
  h.pi.events.emit(EVENTS.unpin, { name: "old" });
  h.run("before_provider_request", { payload: request() });
  assert.equal(h.placed.at(-1).pins.length, 1);
  h.pi.events.emit(EVENTS.unpin, { name: "new" });
  h.run("before_provider_request", { payload: request() });
  assert.equal(h.placed.at(-1).pins.length, 0);
});

test("pending pin cannot bind to warmer replay or an unrelated one-token request", () => {
  const h = harness();
  h.run("before_provider_request", { payload: request("old") });
  h.pi.events.emit(EVENTS.pin, { name: "fork" });
  h.run("before_provider_request", { payload: { ...request("old"), max_tokens: 1 } });
  assert.equal(h.placed.at(-1).pins.length, 0);
  const next = request("new");
  next.messages.unshift(user("old"));
  h.run("before_provider_request", { payload: next });
  assert.equal(h.placed.at(-1).pins[0].at.messageIndex, 1);
});

test("retention mismatch stops warming with an operator-visible reason", () => {
  for (const control of [undefined, { type: "ephemeral", ttl: "1h" }]) {
    const h = harness(), payload = request();
    payload.messages[0].content[0].cache_control = control;
    const out = h.run("before_provider_request", { payload });
    assert.equal(out.messages[0].content[0].cache_control.ttl, "5m");
    assert.deepEqual(h.run("cache_warming_decision", { action: "warm" }), { action: "stop" });
    assert.match(h.placed.at(-1).warming, /unknown or mismatched/);
  }
});

test("TTL changes stop warming, disclose rewrite cost, and preserve in-flight replay TTL", async () => {
  const h = harness();
  h.ctx.model = { api: "anthropic-messages", id: "claude-routed", promptCache: { short: 300 } };
  h.run("before_provider_request", { payload: request() });
  await h.command("1h");
  assert.match(h.notices[0][0], /rewrites.*1h cache-write rate/);
  assert.deepEqual(h.run("cache_warming_decision", { action: "warm" }), { action: "stop" });
  const replay = h.run("before_provider_request", { payload: { ...request(), max_tokens: 1 } });
  assert.equal(replay.messages[0].content[0].cache_control.ttl, "5m");
  h.run("before_provider_request", { payload: request() });
  assert.deepEqual(h.run("cache_warming_decision", { action: "warm" }), { action: "stop" });
  await h.command("5m");
  assert.deepEqual(h.run("cache_warming_decision", { action: "warm" }), { action: "stop" });
  h.run("before_provider_request", { payload: request() });
  assert.equal(h.run("cache_warming_decision", { action: "warm" }), undefined);
});

test("session replacement clears pins, TTL, and replay eligibility", async () => {
  const h = harness();
  await h.command("1h");
  h.pi.events.emit(EVENTS.pin, { name: "fork" });
  h.run("before_provider_request", { payload: request() });
  h.run("session_switch", {});
  assert.equal(h.run("before_provider_request", { payload: { ...request(), max_tokens: 1 } }), undefined);
  h.run("before_provider_request", { payload: request() });
  assert.equal(h.placed.at(-1).ttl, "5m");
  assert.deepEqual(h.placed.at(-1).pins, []);
});

test("optional log failures do not block placement", () => {
  const h = harness({ logPath: new URL("../package.json/log.jsonl", import.meta.url).pathname });
  assert.ok(h.run("before_provider_request", { payload: request() }));
});

test("the /cache TTL lasts for the Session: reload and resume restore it, a new Session does not", async () => {
  const h = harness();
  h.session("s-ttl");
  h.run("session_start", { reason: "startup" });
  await h.command("1h");
  assert.deepEqual(h.entries.map((e) => [e.customType, e.data]), [["cache-goblin:ttl", { sessionTtl: "1h" }]]);
  for (const [down, up] of [["reload", "reload"], ["quit", "resume"], ["quit", "startup"]]) {
    h.run("session_shutdown", { reason: down });
    h.run("session_start", { reason: up });
    h.run("before_provider_request", { payload: request() });
    assert.equal(h.placed.at(-1).ttl, "1h", `after ${down} -> ${up}`);
  }
  h.run("session_shutdown", { reason: "new" });
  h.session("s-new", []);
  h.run("session_start", { reason: "new" });
  h.run("before_provider_request", { payload: request() });
  assert.equal(h.placed.at(-1).ttl, "5m");
});

test("a reload keeps the last request's replay state, so native warming continues; the held pin does not cross it", () => {
  const h = harness();
  h.session("s-reload");
  h.ctx.model = { api: "anthropic-messages", id: "claude-routed", promptCache: { short: 300 } };
  h.run("session_start", { reason: "startup" });
  h.pi.events.emit(EVENTS.pin, { name: "fork" });
  h.run("before_provider_request", { payload: request() });
  assert.equal(h.run("cache_warming_decision", { action: "warm" }), undefined);
  h.run("session_shutdown", { reason: "reload" });
  h.run("session_start", { reason: "reload" });
  assert.equal(h.run("cache_warming_decision", { action: "warm" }), undefined, "warming still eligible after the reload");
  const replay = h.run("before_provider_request", { payload: { ...request(), max_tokens: 1 } });
  assert.equal(replay.messages[0].content[0].cache_control.ttl, "5m", "replay keeps the last real request's TTL");
  assert.deepEqual(h.placed.at(-1).pins.map((p) => p.name), ["fork"], "replay keeps the last real request's layout");
  h.run("before_provider_request", { payload: request("second") });
  assert.deepEqual(h.placed.at(-1).pins, [], "the next real request holds no pin");
  h.run("session_shutdown", { reason: "quit" });
  h.run("session_start", { reason: "resume" });
  assert.deepEqual(h.run("cache_warming_decision", { action: "warm" }), { action: "stop" }, "a new process proves nothing about the cache");
});
