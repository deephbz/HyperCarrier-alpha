#!/usr/bin/env node
import { PLUGIN_ID, runHerdr } from "./lib.mjs";

try {
  const response = runHerdr([
    "plugin",
    "pane",
    "open",
    "--plugin",
    PLUGIN_ID,
    "--entrypoint",
    "rarebit-deck",
    "--placement",
    "popup",
    "--width",
    "90%",
    "--height",
    "88%",
  ]);
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Cannot open Rarebit deck: ${error.message}\n`);
  process.exitCode = 1;
}
