import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { control } from "./pi-fixtures.ts";
import { setup } from "./pi-host-fixtures.ts";

// The old web app sends this unmarked thread.submit after its list returns no_control.
// Reproduced with the actual old bundle and a new hub. A newer hub must not interpret that
// ambiguous request as proof that the owner chose Send as text. Refusal is safe.
test("old page slash: a control appearing after no_control must not receive the command as a user message", async (t) => {
  const { f, browser } = await setup(t);
  const threads = browser.sub("devbox", { kind: "threads" });
  await browser.until<any>(threads, v => v.threads["pi:sess-b"]?.live);
  await assert.rejects(browser.req("devbox", "thread.commands", { threadId: "pi:sess-b" }), (e: any) => e.code === "no_control");
  const ctl = await control(f, f.sessionB, { commands: true, queue: true });
  t.after(() => ctl.close());
  await browser.req("devbox", "thread.submit", { threadId: "pi:sess-b", content: "/model m2", whenBusy: "steer", requestId: "legacy-command" }).catch(() => {});
  assert.deepEqual(ctl.requests.filter(r => r.op === "submit"), [], "a typed command from an old page became a control submit");
});

// Frozen reader from the affected old page. Current sendOutcome cannot verify this contract:
// that code can learn a new error while the open old page still hides its message.
// The actual old web bundle independently reproduces this projection in the browser probe.
function oldPageOutcome(error: { code?: string; message: string }) {
  const refused = new Set(["key_conflict", "command_expired", "bad_request", "bad_args", "unsupported", "unsupported_command", "unknown_command", "commands_unsupported", "command_choice", "busy", "busy_compacting", "audit_empty"]);
  if (refused.has(error.code ?? "")) return { uncertain: false, text: `Not sent: ${error.message.trimEnd().replace(/\.+$/, "")}. Your draft is kept; fix it and send again.` };
  return { uncertain: true, text: "devbox did not answer. Your message is back in the composer. Check the Pi pane before sending again; it may already have arrived." };
}

test("old page slash: the refused submission renders reload guidance in the old reader", async (t) => {
  const { browser } = await setup(t);
  const threads = browser.sub("devbox", { kind: "threads" });
  await browser.until<any>(threads, v => v.threads["pi:sess-b"]?.live);
  const failure = await browser.req("devbox", "thread.submit", { threadId: "pi:sess-b", content: "/model m2", whenBusy: "steer", requestId: "legacy-command" }).then(() => assert.fail("the old command fallback was accepted"), error => error);
  const shown = oldPageOutcome(failure);
  assert.equal(shown.uncertain, false, "the old page must know that nothing was sent");
  assert.match(shown.text, /This page is older than the hub\. Reload it\./, "the old page must show the recovery action");
});

for (const [name, text, editor] of [["leftover editor", "/model m2", "half a thought"], ["unknown name", "/modle m2", ""]] as const) {
  test(`old page slash: ${name} cannot bypass command safety through the legacy fallback`, async (t) => {
    const { f, browser } = await setup(t);
    const state = f.state;
    Object.assign(state.agents.find((a: any) => a.pane_id === "w1:p1"), {
      agent_status: "working", screen: ["assistant", "─".repeat(40), editor, "─".repeat(40), "work p/m1"].join("\n"),
    });
    f.setState(state);
    const threads = browser.sub("devbox", { kind: "threads" });
    await browser.until<any>(threads, v => v.threads["pi:sess-b"]?.live);
    await assert.rejects(browser.req("devbox", "thread.commands", { threadId: "pi:sess-b" }), (e: any) => e.code === "no_control");
    await browser.req("devbox", "thread.submit", { threadId: "pi:sess-b", content: text, whenBusy: "steer", requestId: "legacy-command" }).catch(() => {});
    assert.deepEqual(f.herdrCalls().filter(call => call.some(arg => arg === text)), [], "the legacy fallback bypassed command safety");
  });
}
