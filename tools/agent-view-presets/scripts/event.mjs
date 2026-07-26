#!/usr/bin/env node
import { refreshSelectedView } from "./views.mjs";

try {
  const result = await refreshSelectedView();
  process.stdout.write(
    `${JSON.stringify({ ok: true, event: process.env.HERDR_PLUGIN_EVENT, ...result })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `Agent view preset event ${process.env.HERDR_PLUGIN_EVENT ?? "unknown"} failed: ${error.message}\n`,
  );
  process.exitCode = 1;
}
