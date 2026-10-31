import "./home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hudExtension, { readAliases } from "../src/extension.mjs";
import { renderFooter } from "../src/visual-language.mjs";

test("aliases merge only trusted project settings, per model key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hud-settings-"));
  try {
    const agent = join(dir, "agent"), cwd = join(dir, "project");
    await mkdir(agent); await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(agent, "settings.json"), JSON.stringify({ hc_hud: { model_aliases: { "p/a": "global-a", "p/b": "global-b" } } }));
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ hc_hud: { model_aliases: { "p/a": "project-a", "p/c": 3 } } }));
    const ctx = { cwd, ui: { notify() {} }, isProjectTrusted: () => false };
    assert.deepEqual(await readAliases(ctx, agent), { "p/a": "global-a", "p/b": "global-b" });
    ctx.isProjectTrusted = () => true;
    assert.deepEqual(await readAliases(ctx, agent), { "p/a": "project-a", "p/b": "global-b" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("command changes tier and dumps asOf without model work", async () => {
  const commands = {}, listeners = {}, notifications = [];
  const pi = { events: { on: () => () => {}, emit() {} }, on: (name, fn) => listeners[name] = fn,
    registerCommand: (name, command) => commands[name] = command };
  hudExtension(pi);
  const ctx = { ui: { notify: (message) => notifications.push(message) } };
  await commands.hud.handler("tier minimal", ctx);
  await commands.hud.handler("slots", ctx);
  await commands.hud.handler("tier bad", ctx);
  assert.equal(notifications[0], "HUD tier: minimal");
  assert.equal(notifications[1], "[]");
  assert.match(notifications[2], /Usage:/);
  listeners.session_shutdown();
});
test("long alias sheds before budget; Unicode path still fits", () => {
  const s = { cwd: "/workspace/项目", model: { provider: "p", id: "a" }, aliases: { "p/a": "long".repeat(100) },
    slots: new Map([["context.budget", { asOf: 1, value: { kind: "ratio", used: 50, limit: 100, unit: "tokens", mode: "auto", threshold: 90 } }]]) };
  assert.deepEqual(renderFooter(s, 40), ["/workspace/项目", "50%"]);
});
