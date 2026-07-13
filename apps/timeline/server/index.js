import { createTimelineServer } from "./app.js";
import { resolveCoreHost, resolveServicePort } from "./service-config.js";

const port = resolveServicePort("timeline");
const host = resolveCoreHost();
const reconciliationMs = Number(process.env.PI_TIMELINE_RECONCILIATION_MS ?? 30_000);
createTimelineServer({ reconciliationMs }).listen(port, host, () => {
  console.log(`Pi Session Timeline listening at http://${host}:${port}`);
});
