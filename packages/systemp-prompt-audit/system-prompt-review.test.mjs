import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createSystemPromptExport } from "./system-prompt-export.mjs";
import {
  renderSystemPromptReviewHtml,
  renderSystemPromptReviewMarkdown,
  validateSystemPromptSnapshot,
  writeSystemPromptReviewProjection,
} from "./system-prompt-review.mjs";

const execFileAsync = promisify(execFile);

function snapshot(cwd) {
  return createSystemPromptExport(
    {
      cwd,
      systemPrompt: "# Role\n\n<project_context>\n<script>alert('unsafe')</script>\n</project_context>",
      activeToolNames: ["read"],
      allTools: [{
        name: "read",
        description: "Read <one> file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        promptGuidelines: ["Use read before edit."],
        sourceInfo: { source: "builtin", path: "<builtin:read>" },
      }],
    },
    new Date("2026-08-02T12:34:56.000Z"),
  );
}

test("renders deterministic annotation-ready Markdown and script-free styled HTML", () => {
  const artifact = snapshot("/workspace");
  const markdown = renderSystemPromptReviewMarkdown(artifact, "snapshot.json");
  const html = renderSystemPromptReviewHtml(artifact, "snapshot.json");

  assert.equal(markdown, renderSystemPromptReviewMarkdown(artifact, "snapshot.json"));
  assert.equal(html, renderSystemPromptReviewHtml(artifact, "snapshot.json"));
  assert.doesNotMatch(markdown, /Work OS review frame/);
  assert.match(markdown, /- Exact lines or field:/);
  assert.match(markdown, /- How to verify:/);
  const exact = markdown.match(/<!-- BEGIN EXACT SYSTEM PROMPT -->\n\n([\s\S]*?)\n\n<!-- END EXACT SYSTEM PROMPT -->/);
  const fenced = exact?.[1].split("\n") ?? [];
  assert.match(fenced[0], /^`{3,}text$/);
  assert.equal(fenced.at(-1), fenced[0].replace(/text$/, ""));
  assert.equal(fenced.slice(1, -1).join("\n"), artifact.systemPrompt);
  assert.match(markdown, /Read &lt;one&gt; file\./);

  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /Work OS review frame/);
  assert.doesNotMatch(html, /Reviewer annotation/);
  assert.match(html, /data-source-sha256=/);
  assert.match(html, /data-cumulative-chars="6" data-estimated-tokens="2"/);
  assert.match(html, /Line · cumulative ≈tokens \(Unicode characters ÷ 4\)/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&#39;unsafe&#39;\)&lt;\/script&gt;/);
  assert.match(html, /Read &lt;one&gt; file\./);
});

test("validates snapshot content integrity and duplicate tool names", () => {
  const artifact = snapshot("/workspace");
  assert.equal(validateSystemPromptSnapshot(artifact), artifact);
  assert.throws(
    () => validateSystemPromptSnapshot({ ...artifact, systemPrompt: "changed" }),
    /SHA-256 mismatch/,
  );
  const duplicate = { ...artifact, activeTools: [artifact.activeTools[0], artifact.activeTools[0]] };
  duplicate.integrity = {
    contentSha256: createHash("sha256")
      .update(JSON.stringify({ systemPrompt: duplicate.systemPrompt, activeTools: duplicate.activeTools }))
      .digest("hex"),
  };
  assert.throws(() => validateSystemPromptSnapshot(duplicate), /Duplicate active tool/);
});

test("writes an immutable Markdown and HTML review pair beside verified JSON", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-prompt-review-"));
  const artifact = snapshot(cwd);
  const snapshotPath = path.join(cwd, ".pi/prompt-snapshots/evidence.json");
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const result = await writeSystemPromptReviewProjection({
    cwd,
    snapshotPath: ".pi/prompt-snapshots/evidence.json",
  });
  assert.equal(result.reviewPath, path.join(cwd, ".pi/prompt-snapshots/evidence.review.md"));
  assert.equal(result.htmlPath, path.join(cwd, ".pi/prompt-snapshots/evidence.review.html"));
  assert.equal(
    result.markdownSha256,
    createHash("sha256").update(await readFile(result.reviewPath, "utf8")).digest("hex"),
  );
  assert.equal(
    result.htmlSha256,
    createHash("sha256").update(await readFile(result.htmlPath, "utf8")).digest("hex"),
  );
  await assert.rejects(
    writeSystemPromptReviewProjection({ cwd, snapshotPath: ".pi/prompt-snapshots/evidence.json" }),
    (error) => error.code === "EEXIST",
  );
  await assert.rejects(
    writeSystemPromptReviewProjection({ cwd, snapshotPath: "../outside.json" }),
    /inside the current working directory/,
  );
});

test("offers the same deterministic renderer through the model-free CLI", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-prompt-review-cli-"));
  const artifact = snapshot(cwd);
  await writeFile(path.join(cwd, "snapshot.json"), JSON.stringify(artifact));
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "render-snapshot.mjs");
  const { stdout } = await execFileAsync(process.execPath, [cli, "snapshot.json"], { cwd });
  const receipt = JSON.parse(stdout);
  const childCwd = await realpath(cwd);
  assert.equal(receipt.sourceContentSha256, artifact.integrity.contentSha256);
  assert.equal(receipt.reviewPath, path.join(childCwd, "snapshot.review.md"));
  assert.equal(receipt.htmlPath, path.join(childCwd, "snapshot.review.html"));
});
