#!/usr/bin/env node
import { currentPaneId } from "./lib.mjs";
import { refreshRarebitPaneAfterSettlement } from "./rarebit.mjs";

let event = {};
try {
  event = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}");
} catch {
  event = {};
}

const eventName = process.env.HERDR_PLUGIN_EVENT || event.event || "unknown";
const paneId = event?.data?.pane_id || currentPaneId();
async function refreshAfterMaterializationSettlement() {
  return refreshRarebitPaneAfterSettlement(paneId, `event:${eventName}`, event);
}

try {
  if (!paneId) process.exit(0);
  if (eventName !== "pane.closed")
    await refreshAfterMaterializationSettlement();
} catch (error) {
  // Exact-Session Rarebit data is optional; non-Pi or unbound panes degrade quietly.
  process.stderr.write(
    `Rarebit event ${eventName} unavailable: ${error.message}\n`,
  );
}
