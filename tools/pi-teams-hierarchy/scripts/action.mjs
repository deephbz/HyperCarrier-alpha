#!/usr/bin/env node
import { clearAllHierarchy, reconcileHierarchy } from "./hierarchy.mjs";

const action = process.argv[2];
try {
  let result;
  if (action === "refresh-all") {
    result = await reconcileHierarchy({ reason: "action:refresh-all" });
  } else if (action === "clear-all") {
    result = clearAllHierarchy({ reason: "action:clear-all" });
  } else {
    throw new Error(`Unknown action: ${action ?? "missing"}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, action, ...result })}\n`);
} catch (error) {
  process.stderr.write(
    `Pi Teams hierarchy action ${action ?? "unknown"} failed: ${error.message}\n`,
  );
  process.exitCode = 1;
}
