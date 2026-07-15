#!/usr/bin/env node
import { queryKeyMessages } from "../src/session-query.mjs";

const USAGE = "Usage: hc-key-messages --session <exact-path-or-id> --json";

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  let session;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--session") {
      session = argv[index + 1];
      index += 1;
    } else if (argument === "--json") json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!session) throw new Error("--session is required");
  if (!json) throw new Error("--json is required");
  return { session, json };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
  } else {
    const result = await queryKeyMessages(options.session);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error?.message ?? String(error)}\n${USAGE}\n`);
  process.exitCode = 1;
}
