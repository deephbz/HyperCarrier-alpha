#!/usr/bin/env node
import {
  RAREBIT_CLI_USAGE,
  parseRarebitCliArgs,
  runRarebitCli,
} from "../src/rarebit-cli.mjs";

try {
  const options = parseRarebitCliArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(`${RAREBIT_CLI_USAGE}\n`);
  else
    process.stdout.write(
      `${JSON.stringify(await runRarebitCli(options), null, 2)}\n`,
    );
} catch (error) {
  process.stderr.write(
    `${error?.message ?? String(error)}\n${RAREBIT_CLI_USAGE}\n`,
  );
  process.exitCode = 1;
}
