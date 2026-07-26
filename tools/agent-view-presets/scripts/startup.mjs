#!/usr/bin/env node
import { refreshSelectedView } from "./views.mjs";

try {
  const result = await refreshSelectedView();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  process.stderr.write(`Agent view preset startup failed: ${error.message}\n`);
  process.exitCode = 1;
}
