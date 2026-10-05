#!/usr/bin/env node
// Offline CLI. Same arguments as /ttl-backtest. Prices come from the extension's catalog
// snapshot when present, else ~/.pi/agent/models-store.json + models.json.

import { parseArgs } from "../src/args.mjs";
import { DEFAULT_STATE_DIR, ingest } from "../src/ingest.mjs";
import { catalogFromDisk } from "../src/pricing.mjs";
import { backtest, textReport, webPayload } from "../src/report.mjs";
import { openUrl, serve } from "../src/server.mjs";

const o = await parseArgs(process.argv.slice(2));
const data = await ingest({ sinceMs: o.sinceMs, untilMs: o.untilMs, useIndex: o.useIndex });
const catalog = await catalogFromDisk(DEFAULT_STATE_DIR);
const bt = backtest(data, catalog.models, o);
console.log(textReport(data, bt));
console.log(`\nPrices: ${catalog.source}`);
if (o.serve) {
  const { url } = await serve(webPayload(data, bt, { catalogSource: catalog.source }));
  console.log(`Web view: ${url}  (Ctrl-C to stop)`);
  if (o.open) openUrl(url);
}
