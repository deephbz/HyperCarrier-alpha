#!/usr/bin/env node
import { reconcileHierarchy } from "./hierarchy.mjs";

try {
  const result = await reconcileHierarchy({ reason: "startup:reconcile" });
  process.stdout.write(
    `Pi Teams hierarchy reconciled ${result.published}/${result.liveAgentCount} live Agents\n`,
  );
} catch (error) {
  process.stderr.write(
    `Pi Teams hierarchy startup reconciliation failed: ${error.message}\n`,
  );
  process.exitCode = 1;
}
