#!/usr/bin/env node
import { applyNoTeammates, showAllAgents, toggleTeammates } from "./views.mjs";

const command = process.argv[2] || process.env.HERDR_PLUGIN_ACTION_ID;

try {
  let result;
  switch (command) {
    case "toggle-teammates":
      result = await toggleTeammates();
      break;
    case "no-teammates":
      result = await applyNoTeammates();
      break;
    case "all-agents":
      result = await showAllAgents();
      break;
    default:
      throw new Error(`Unknown Agent view preset: ${command ?? "<missing>"}`);
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, command, ...result }, null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(
    `Agent view preset ${command ?? "<missing>"} failed: ${error.message}\n`,
  );
  process.exitCode = 1;
}
