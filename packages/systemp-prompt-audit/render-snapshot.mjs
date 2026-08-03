#!/usr/bin/env node

import { writeSystemPromptReviewProjection } from "./system-prompt-review.mjs";

function usage() {
  return "Usage: node render-snapshot.mjs SNAPSHOT.json [REVIEW.md]";
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}
if (args.length < 1 || args.length > 2) {
  console.error(usage());
  process.exit(2);
}

try {
  const result = await writeSystemPromptReviewProjection(
    { cwd: process.cwd(), snapshotPath: args[0] },
    { reviewPath: args[1] },
  );
  console.log(JSON.stringify({
    snapshotPath: result.snapshotPath,
    reviewPath: result.reviewPath,
    htmlPath: result.htmlPath,
    sourceContentSha256: result.snapshot.integrity.contentSha256,
    markdownSha256: result.markdownSha256,
    htmlSha256: result.htmlSha256,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
