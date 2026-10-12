import assert from "node:assert/strict";
import { test } from "node:test";
import { findGlobalBoundary } from "../src/system-split.mjs";
import { assertTtlOrder, findTail, headOf, placeMarkers, prefixHash } from "../src/plan.mjs";

const GLOBAL = "/global/AGENTS.md";
const piPrompt = (files) =>
  [
    "You are an expert coding assistant operating inside pi.",
    "<tools>\n- read: Read\n</tools>",
    "<rules>\n- Be concise\n</rules>",
    ...(files.length
      ? [
          `<project_context>\nProject-specific instructions and guidelines:\n\n${files
            .map(([path, body]) => `<project_instructions path="${path}">\n${body}\n</project_instructions>`)
            .join("\n\n")}\n</project_context>`,
        ]
      : []),
    "<skills>\n- s\n</skills>",
    "<cwd>\n/work/a\n</cwd>",
  ].join("\n\n");

const boundary = (text) => findGlobalBoundary(text, { globalPaths: [GLOBAL] });

const payload = (system, messages) => ({
  model: "claude-haiku-5-5",
  max_tokens: 1000,
  stream: true,
  tools: [{ name: "read", input_schema: {}, cache_control: { type: "ephemeral" } }],
  system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
  messages,
});

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const effort = { role: "system", content: [], output_config: { effort: "high" } };

const allMarkers = (p) => [
  ...(p.tools ?? []).filter((b) => b.cache_control),
  ...p.system.filter((b) => b.cache_control),
  ...p.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.cache_control),
];

test("global layer ends after the global context file and before project files", () => {
  const text = piPrompt([[GLOBAL, "global rules"], ["/work/a/AGENTS.md", "project rules"]]);
  const at = boundary(text);
  assert.ok(text.slice(0, at).endsWith("global rules\n</project_instructions>"));
  assert.ok(text.slice(at).startsWith("\n\n<project_instructions path=\"/work/a/AGENTS.md\">"));
});

test("global layer ends before <project_context> when no global file is loaded", () => {
  const text = piPrompt([["/work/a/AGENTS.md", "project rules"]]);
  assert.ok(text.slice(boundary(text)).startsWith("<project_context>"));
});

test("global layer ends before <skills> when there is no project context", () => {
  const text = piPrompt([]);
  assert.ok(text.slice(boundary(text)).startsWith("<skills>"));
});

test("a custom prompt without pi sections has no global boundary", () => {
  assert.equal(boundary("You are a bot."), -1);
});

test("system splits into global and project blocks, both 1h; tools lose pi's marker", () => {
  const text = piPrompt([[GLOBAL, "g"], ["/work/a/AGENTS.md", "p"]]);
  const { payload: out, markers } = placeMarkers(payload(text, [user("hi"), effort]), { sessionTtl: "5m", globalBoundary: boundary });
  assert.equal(out.system.length, 2);
  assert.equal(out.system.map((b) => b.text).join(""), text, "split must not change the text");
  assert.deepEqual(out.system.map((b) => b.cache_control), [{ type: "ephemeral", ttl: "1h" }, { type: "ephemeral", ttl: "1h" }]);
  assert.equal(out.tools[0].cache_control, undefined);
  assert.deepEqual(markers.map((m) => [m.layer, m.ttl]), [["global", "1h"], ["project", "1h"], ["tail", "5m"]]);
});

test("tail marker skips pi's trailing effort message and uses the session TTL", () => {
  const msgs = [user("a"), assistant("b"), user("c"), effort];
  const { payload: out } = placeMarkers(payload("x", msgs), { sessionTtl: "1h" });
  assert.deepEqual(out.messages[2].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(out.messages[0].content[0].cache_control, undefined);
  assert.equal(allMarkers(out).length, 2);
});

test("input payload is not mutated", () => {
  const input = payload("x", [user("a")]);
  const before = JSON.stringify(input);
  placeMarkers(input, { sessionTtl: "5m" });
  assert.equal(JSON.stringify(input), before);
});

test("a pending pin resolves to this request's tail and is held on later requests", () => {
  const first = [user("a"), assistant("b"), user("A"), effort];
  const r1 = placeMarkers(payload("x", first), { sessionTtl: "5m", pins: [{ name: "fork" }] });
  assert.equal(r1.pins[0].status, "placed");
  assert.deepEqual([r1.pins[0].at.messageIndex, r1.pins[0].at.blockIndex], [2, 0]);

  const later = [user("a"), assistant("b"), user("A"), assistant("c"), user("d"), effort];
  const r2 = placeMarkers(payload("x", later), { sessionTtl: "5m", pins: [{ name: "fork", at: r1.pins[0].at }] });
  assert.equal(r2.pins[0].status, "placed");
  assert.deepEqual(r2.payload.messages[2].content[0].cache_control, { type: "ephemeral", ttl: "5m" });
  assert.deepEqual(r2.payload.messages[4].content[0].cache_control, { type: "ephemeral", ttl: "5m" });
});

test("a pin goes stale when the prefix before it changed (e.g. after compaction)", () => {
  const first = [user("a"), assistant("b"), user("A")];
  const at = { messageIndex: 2, blockIndex: 0, hash: prefixHash(first, { messageIndex: 2, blockIndex: 0 }, headOf(payload("x", first))) };
  const changed = [user("SUMMARY"), assistant("b"), user("A"), assistant("c"), user("d")];
  const r = placeMarkers(payload("x", changed), { sessionTtl: "5m", pins: [{ name: "fork", at }] });
  assert.equal(r.pins[0].status, "stale");
  assert.equal(r.markers.filter((m) => m.layer === "pin").length, 0);
});

test("a pin goes stale when the system prompt or thinking changed, even with the same messages", () => {
  const msgs = [user("a"), assistant("b"), user("A")];
  const r1 = placeMarkers(payload("x", msgs), { sessionTtl: "5m", pins: [{ name: "fork" }] });
  const later = [...msgs, assistant("c"), user("d")];
  const r2 = placeMarkers(payload("y", later), { sessionTtl: "5m", pins: [{ name: "fork", at: r1.pins[0].at }] });
  assert.equal(r2.pins[0].status, "stale");
  const thinking = { ...payload("x", later), thinking: { type: "disabled" } };
  const r3 = placeMarkers(thinking, { sessionTtl: "5m", pins: [{ name: "fork", at: r1.pins[0].at }] });
  assert.equal(r3.pins[0].status, "stale");
});

test("over budget, the oldest pin is dropped and the total stays at 4", () => {
  const text = piPrompt([[GLOBAL, "g"], ["/work/a/AGENTS.md", "p"]]);
  const msgs = [user("p1"), assistant("x"), user("p2"), assistant("y"), user("tail")];
  const head = headOf(payload(text, msgs));
  const pin = (i) => ({ messageIndex: i, blockIndex: 0, hash: prefixHash(msgs, { messageIndex: i, blockIndex: 0 }, head) });
  const r = placeMarkers(payload(text, msgs), {
    sessionTtl: "5m",
    globalBoundary: boundary,
    pins: [{ name: "old", at: pin(0) }, { name: "new", at: pin(2) }],
  });
  assert.equal(allMarkers(r.payload).length, 4);
  assert.deepEqual(r.pins.map((p) => [p.name, p.status]), [["old", "dropped"], ["new", "placed"]]);
});

test("TTL order: a 1h marker after a 5m marker is rejected", () => {
  assert.throws(() => assertTtlOrder([{ layer: "tail", ttl: "5m" }, { layer: "pin", ttl: "1h" }]));
  assert.throws(() => placeMarkers(payload("x", [user("a")]), { sessionTtl: "1h", layerTtl: "5m" }));
});

test("no tail marker when the conversation ends with an assistant message", () => {
  assert.equal(findTail([user("a"), assistant("b")]), null);
});

test("string content is normalized to one text block so its prefix bytes stay stable", () => {
  const r = placeMarkers(payload("x", [{ role: "user", content: "hello" }]), { sessionTtl: "5m" });
  assert.deepEqual(r.payload.messages[0].content, [{ type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "5m" } }]);
});
