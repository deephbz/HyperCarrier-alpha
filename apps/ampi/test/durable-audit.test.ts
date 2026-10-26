import "./bound.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { durableAuditReview } from "../src/durable/prompt-audit.ts";

/** A synthetic node snapshot in the renderer's schemaVersion 1 shape. */
function snapshot(systemPrompt = "You are a synthetic agent.") {
 const activeTools = [{ name: "read", description: "Read a file.", parameters: { type: "object" } }];
 const contentSha256 = createHash("sha256").update(JSON.stringify({ systemPrompt, activeTools })).digest("hex");
 return { schemaVersion: 1, capturedAt: "2026-10-25T00:00:00.000Z", cwd: "/demo", systemPrompt, activeTools, provenance: { systemPrompt: "durable node" }, integrity: { contentSha256 } };
}

test("audit review fetches the node snapshot at an entry and renders it unchanged", async () => {
 const calls: unknown[] = [];
 const review = await durableAuditReview(async (op, args) => (calls.push([op, args]), snapshot()), "demo", { threadId: "t1", entryId: "e7" });
 assert.deepEqual(calls, [["audit.snapshot", { threadId: "t1", entryId: "e7" }]]);
 assert.equal(review.source, "demo/pi-durable:t1#e7");
 assert.match(review.markdown, /You are a synthetic agent\./);
 assert.match(review.markdown, /demo\/pi-durable:t1#e7/);
 assert.match(review.html, /You are a synthetic agent\./);
 let latestArgs: unknown;
 const latest = await durableAuditReview(async (_op, args) => ((latestArgs = args), snapshot()), "demo", { threadId: "t1" });
 assert.deepEqual(latestArgs, { threadId: "t1" });
 assert.equal(latest.source, "demo/pi-durable:t1");
});

test("audit review refuses a snapshot whose content hash does not match", async () => {
 const bad = { ...snapshot(), systemPrompt: "changed" };
 await assert.rejects(durableAuditReview(async () => bad, "demo", { threadId: "t1" }), /SHA-256 mismatch/);
 await assert.rejects(durableAuditReview(async () => ({ schemaVersion: 2 }), "demo", { threadId: "t1" }), /schemaVersion/);
});
