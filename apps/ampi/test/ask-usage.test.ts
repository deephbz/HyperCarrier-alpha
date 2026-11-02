import "./bound.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ask, ASK_CONCURRENCY, BACKGROUND_CONCURRENCY } from "../src/pi/ask.ts";
import { limitOutput } from "../src/pi/ask-limit.ts";
test("ask retains cache usage and reports billed usage on model failures", async t => {
 const dir = mkdtempSync(join(tmpdir(), "ask-usage-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const old = process.env.PI_BIN, bin = join(dir, "pi"); process.env.PI_BIN = bin;
 t.after(() => { if (old === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = old; });
 const usage = { input: 3, output: 50, cacheRead: 12000, cacheWrite: 800, cost: { total: .02 } };
 const fake = (stopReason: string, resetAt?: string) => { writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify(${JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "fixture", model: "model", content: [{ type: "text", text: "Answer" }], stopReason, resetAt, usage } })})));`); chmodSync(bin, 0o755); };
 fake("stop"); const result = await ask({ system: "Answer.", prompt: "Question", model: "fixture/model", resolved: true });
 assert.deepEqual(result.usage, { ...usage, cost: .02 });
 fake("error"); await assert.rejects(ask({ system: "Answer.", prompt: "Question" }), e => (e as any).usage?.cost === .02);
 fake("length"); assert.equal((await ask({ system: "Answer.", prompt: "Question" })).truncated, true);
 const resetAt = "2099-01-01T00:00:00Z"; fake("error", resetAt);
 await assert.rejects(ask({ system: "Answer.", prompt: "Question" }), e => (e as { resetAt?: string }).resetAt === resetAt);
 writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on("end", () => { console.log(JSON.stringify(${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "aborted", usage } })})); setInterval(() => {}, 1000); });`); chmodSync(bin, 0o755);
 await assert.rejects(ask({ system: "Answer.", prompt: "Question", timeoutMs: 1500 }), e => (e as { code?: string; usage?: { cost?: number } }).code === "timeout" && (e as { usage?: { cost?: number } }).usage?.cost === .02);
});
test("ask caps supported provider payloads and refuses unknown payloads", () => {
 assert.deepEqual(limitOutput({ max_tokens: 64000, messages: [] }, 8000), { max_tokens: 8000, messages: [] });
 assert.deepEqual(limitOutput({ max_output_tokens: 4000 }, 8000), { max_output_tokens: 4000 });
 assert.throws(() => limitOutput({ unexpected: true }, 8000), /output limit/);
});
// Contract: arc.md / Triggers: background calls hold at most all slots but one; the last slot serves interactive calls.
test("ask reserves one interactive slot while seven background calls run, and refuses a ninth call", async () => {
 const command = [process.execPath, "-e", "process.stdin.resume(); process.stdin.on('end',()=>setTimeout(()=>console.log('ok'),300));"];
 const req = { system: "Answer", prompt: "Test", admission: "background" as const };
 const held = Array.from({ length: BACKGROUND_CONCURRENCY }, () => ask(req, command));
 await assert.rejects(ask(req, command), { code: "busy" });
 const interactive = ask({ ...req, admission: "interactive" }, command);
 await assert.rejects(ask({ ...req, admission: "interactive" }, command), { code: "busy" }, "all slots held");
 assert.equal(BACKGROUND_CONCURRENCY + 1, ASK_CONCURRENCY);
 assert.equal((await interactive).text, "ok"); await Promise.all(held);
});
