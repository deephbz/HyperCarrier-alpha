import { createTimelineServer } from "./app.js";

const port = Number(process.env.PORT ?? 4318);
const host = process.env.HOST ?? "127.0.0.1";
const reconciliationMs = Number(process.env.PI_TIMELINE_RECONCILIATION_MS ?? 30_000);
createTimelineServer({ reconciliationMs }).listen(port, host, () => {
  console.log(`Pi Session Timeline listening at http://${host}:${port}`);
});
