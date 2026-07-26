#!/usr/bin/env node
import { currentPaneId } from "./lib.mjs";
import {
  clearRarebitPane,
  compactRarebitView,
  notifyRarebit,
  refreshAllRarebits,
  refreshRarebitPane,
} from "./rarebit.mjs";

const command = process.argv[2] || process.env.HERDR_PLUGIN_ACTION_ID;
const paneId = currentPaneId();
try {
  let result;
  switch (command) {
    case "refresh-current":
      result = compactRarebitView(
        await refreshRarebitPane(paneId, "action:refresh-current"),
      );
      break;
    case "refresh-all":
      result = await refreshAllRarebits("action:refresh-all");
      break;
    case "show-notification":
      result = await notifyRarebit(paneId);
      break;
    case "clear-current":
      clearRarebitPane(paneId, "action:clear-current");
      result = { paneId, cleared: true };
      break;
    default:
      throw new Error(
        `Unknown Rarebit Status action: ${command ?? "<missing>"}`,
      );
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, command, result }, null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(
    `Rarebit Status action ${command ?? "<missing>"} failed: ${error.message}\n`,
  );
  process.exitCode = 1;
}
