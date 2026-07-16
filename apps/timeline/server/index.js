import { createTimelineServer } from "./app.js";
import {
  resolveCoreHost,
  resolveServicePort,
  resolveTimelineSourceOptions,
} from "./service-config.js";
import { timelineWatchRoots } from "./watcher.js";

const port = resolveServicePort("timeline");
const host = resolveCoreHost();
const reconciliationMs = Number(process.env.PI_TIMELINE_RECONCILIATION_MS ?? 30_000);
const collectionOptions = resolveTimelineSourceOptions();
const watchRoots = timelineWatchRoots(collectionOptions);
createTimelineServer({ reconciliationMs, collectionOptions, watchRoots }).listen(port, host, () => {
  console.log(`Pi Session Timeline listening at http://${host}:${port}`);
});
