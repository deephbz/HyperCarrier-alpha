#!/usr/bin/env node
import { reconcileHierarchy } from "./hierarchy.mjs";
import { affectedPaneId, eventContext } from "./lib.mjs";

const event = eventContext();
const eventName = process.env.HERDR_PLUGIN_EVENT || event.event || "unknown";
const paneId = affectedPaneId(event);
const delays = eventName === "pane.agent_detected"
  ? [0, 50, 100, 200, 400, 800]
  : eventName === "pane.closed"
    ? [0, 150]
    : [0];

try {
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
    const result = await reconcileHierarchy({
      reason: `event:${eventName}:${attempt + 1}`,
      // First pass labels the leader too. Later settlement retries touch only
      // the detected pane and do not republish every existing Team member.
      targetPaneId:
        eventName === "pane.agent_detected" && attempt > 0 ? paneId : undefined,
    });
    if (
      eventName !== "pane.agent_detected" ||
      !paneId ||
      result.matches.some((match) => match.paneId === paneId)
    ) break;
  }
} catch (error) {
  // Team presentation is optional. Coordination identity remains authoritative.
  process.stderr.write(
    `Pi Teams hierarchy event ${eventName} unavailable: ${error.message}\n`,
  );
}
