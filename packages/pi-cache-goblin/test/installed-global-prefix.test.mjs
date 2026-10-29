import "./home.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCacheGoblinExtension, EVENTS } from "../src/extension.mjs";
import { placeMarkers } from "../src/plan.mjs";
import { findGlobalBoundary } from "../src/system-split.mjs";

// Optional installed-runtime proof. The normal suite never resolves shared workspace Pi dependencies.
const modules = process.env.PI_CACHE_GOBLIN_PI_MODULES;
test("installed Pi 1.1 loader, builder, and Messages converter share the exact global prefix across Projects", {
  skip: !modules && "set PI_CACHE_GOBLIN_PI_MODULES to installed Pi 1.1 node_modules",
}, async () => {
  const codingRoot = join(resolve(modules), "@earendil-works/pi-coding-agent");
  const aiRoot = join(resolve(modules), "@earendil-works/pi-ai");
  const manifest = JSON.parse(await readFile(join(codingRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, "1.1.0", "proof is anchored to the installed 1.1.0 builder");
  const { loadProjectContextFiles } = await import(pathToFileURL(join(codingRoot, "dist/core/resource-loader.js")));
  const { buildSystemPromptState, buildSystemPrompt } = await import(pathToFileURL(join(codingRoot, "dist/core/system-prompt.js")));
  const { stream } = await import(pathToFileURL(join(aiRoot, "dist/api/anthropic-messages.js")));
  const worktree = fileURLToPath(new URL("../../../", import.meta.url));
  const scratch = join(worktree, ".scratch");
  const fixtures = join(scratch, "cache-global-proof-fixtures");
  await mkdir(fixtures, { recursive: true });
  const agentDir = join(fixtures, "agent");
  const globalPath = join(agentDir, "AGENTS.md");
  const globalText = "GLOBAL_PROBE_9267\nKeep these synthetic global instructions exact.";
  await mkdir(agentDir, { recursive: true });
  await writeFile(globalPath, globalText);
  const records = [];
  const limits = [];
  const model = { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-5",
    name: "Synthetic physical model", baseUrl: "https://api.anthropic.com", reasoning: false,
    input: ["text"], maxTokens: 100, contextWindow: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, promptCache: { short: 300, long: 3600 } };
  const tool = { name: "read", description: "Read a synthetic file", parameters: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"],
  } };
  for (const project of ["a", "b"]) {
    const cwd = join(fixtures, `project-${project}`);
    const projectPath = join(cwd, "AGENTS.md");
    const projectText = `PROJECT_${project.toUpperCase()}_PROBE_9267\nOnly this Project uses these instructions.`;
    await mkdir(cwd, { recursive: true });
    await writeFile(projectPath, projectText);
    const loaded = loadProjectContextFiles({ cwd, agentDir });
    assert.equal(loaded[0].path, globalPath, "installed loader puts agent instructions first");
    assert.equal(loaded.at(-1).path, projectPath, "installed loader puts cwd instructions last");
    // Isolate synthetic input from real ancestor instructions. Preserve loader order.
    const contextFiles = loaded.filter((file) => file.path.startsWith(`${fixtures}/`));
    assert.deepEqual(contextFiles.map((file) => file.path), [globalPath, projectPath]);
    const options = { cwd, contextFiles, skills: [], selectedTools: ["read"],
      toolSnippets: { read: "Read a synthetic file" } };
    const handlers = new Map();
    let placement;
    createCacheGoblinExtension({ globalPaths: [globalPath] })({
      on: (event, fn) => handlers.set(event, fn), registerCommand: () => {},
      events: { on: () => {}, emit: (event, data) => { if (event === EVENTS.placed) placement = data; } },
    });
    const sent = [];
    let original;
    // Inject a local SDK client. No credential resolution, fetch, or HTTP call occurs.
    const client = { beta: { messages: { create: (params) => {
      sent.push(structuredClone(params));
      const events = [
        { type: "message_start", message: { id: "synthetic-response", type: "message", role: "assistant",
          model: model.id, content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
        { type: "message_stop" },
      ];
      return { asResponse: async () => new Response(events.map((event) =>
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      }) };
    } } } };
    const response = await stream(model, { messages: [
      { role: "system", ...buildSystemPromptState(options), timestamp: 0, toolsAdded: [tool] },
      { role: "user", content: [{ type: "text", text: "synthetic request" }], timestamp: 1 },
    ] }, { client, maxTokens: 100, cacheRetention: "short", onPayload: (payload) => {
      original = structuredClone(payload);
      return handlers.get("before_provider_request")({ payload }, { model });
    } }).result();
    assert.equal(response.stopReason, "stop", response.errorMessage);
    assert.equal(sent.length, 1);
    assert.equal(original.system.map((block) => block.text).join(""), buildSystemPrompt(options));
    const actual = sent[0];
    const globalMarker = placement.markers.find((marker) => marker.layer === "global");
    assert.ok(globalMarker, "ordinary installed layout must get a global marker");
    const globalPrefix = actual.system.slice(0, globalMarker.system + 1).map((block) => block.text).join("");
    assert.ok(globalPrefix.endsWith(`${globalText}\n</project_instructions>`));
    assert.ok(globalPrefix.includes("<tools>"));
    assert.ok(globalPrefix.includes("GLOBAL_PROBE_9267"));
    assert.ok(!globalPrefix.includes("PROJECT_A_PROBE_9267"));
    assert.ok(!globalPrefix.includes("PROJECT_B_PROBE_9267"));
    assert.ok(!globalPrefix.includes(projectPath));
    assert.ok(!globalPrefix.includes(`<cwd>\n${cwd}`));
    assert.ok(actual.system.map((block) => block.text).join("").includes(projectText));
    assert.equal(actual.system.map((block) => block.text).join(""), original.system.map((block) => block.text).join(""));
    assert.deepEqual(actual.system[globalMarker.system].cache_control, { type: "ephemeral", ttl: "1h" });
    const record = { project, cwd, contextPaths: contextFiles.map((file) => file.path),
      original, sent: actual, placement, globalPrefix };
    records.push(record);
    await writeFile(join(scratch, `cache-global-proof-${project}.json`), `${JSON.stringify(record, null, 2)}\n`);

    const appendedText = buildSystemPrompt({ ...options, appendSystemPrompt: `APPENDED_PROJECT_${project.toUpperCase()}_PROBE` });
    const withAppend = placeMarkers({ ...original, system: [{ type: "text", text: appendedText }] }, {
      sessionTtl: "5m", globalBoundary: (text) => findGlobalBoundary(text, { globalPaths: [globalPath] }),
    });
    const appendMarker = withAppend.markers.find((marker) => marker.layer === "global");
    const appendPrefix = withAppend.payload.system.slice(0, appendMarker.system + 1).map((block) => block.text).join("");
    assert.ok(!appendPrefix.includes("APPENDED_PROJECT_"));
    assert.ok(!appendPrefix.includes("GLOBAL_PROBE_9267"), "global AGENTS after unknown addendum cannot join shared prefix");
    assert.ok(!appendPrefix.includes("PROJECT_A_PROBE_9267"));
    assert.ok(!appendPrefix.includes("PROJECT_B_PROBE_9267"));
    assert.equal(withAppend.payload.system.map((block) => block.text).join(""), appendedText);
    const forcedText = buildSystemPrompt({ ...options, forceSystemPrompt: "OPAQUE_FORCED_PROMPT" });
    const forced = placeMarkers({ ...original, system: [{ type: "text", text: forcedText }] }, {
      sessionTtl: "5m", globalBoundary: (text) => findGlobalBoundary(text, { globalPaths: [globalPath] }),
    });
    assert.equal(forced.payload.system.length, 1);
    assert.equal(forced.payload.system[0].text, "OPAQUE_FORCED_PROMPT");
    assert.ok(!forced.markers.some((marker) => marker.layer === "global"));
    limits.push({ project, appendedText, appendPrefix, appendMarkers: withAppend.markers,
      forcedText, forcedMarkers: forced.markers });
  }
  assert.equal(records[0].globalPrefix, records[1].globalPrefix, "provider system prefixes must be byte-identical");
  assert.deepEqual(records[0].sent.tools, records[1].sent.tools, "tools before the system must also match");
  assert.notEqual(records[0].sent.system.at(-1).text, records[1].sent.system.at(-1).text);
  assert.equal(limits[0].appendPrefix, limits[1].appendPrefix);
  await writeFile(join(scratch, "cache-global-proof-limits.json"), `${JSON.stringify(limits, null, 2)}\n`);
  await rm(fixtures, { recursive: true });
});
