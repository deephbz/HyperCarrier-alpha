#!/usr/bin/env node
import { refreshAllRarebits } from "./rarebit.mjs";

try {
  const results = await refreshAllRarebits("startup:reconcile");
  const refreshed = results.filter((result) => result.ok).length;
  process.stdout.write(
    `Rarebit reconciled ${refreshed}/${results.length} exact Session bindings\n`,
  );
} catch (error) {
  process.stderr.write(
    `Rarebit startup reconciliation failed: ${error.message}\n`,
  );
  process.exitCode = 1;
}
