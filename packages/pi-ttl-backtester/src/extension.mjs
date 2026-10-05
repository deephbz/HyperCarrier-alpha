// Pi extension: /ttl-backtest [since] [until] [--prices file] [--no-serve] [--no-open]

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, splitArgs } from "./args.mjs";
import { DEFAULT_STATE_DIR, ingest } from "./ingest.mjs";
import { catalogFromRegistry } from "./pricing.mjs";
import { backtest, textReport, webPayload } from "./report.mjs";
import { openUrl, serve } from "./server.mjs";

export default function ttlBacktester(pi) {
  let active = null;
  const close = () => {
    active?.server.close();
    active = null;
  };

  pi.on("session_shutdown", close);

  pi.registerCommand("ttl-backtest", {
    description: "Backtest prompt-cache TTL strategies against local session usage",
    handler: async (args, ctx) => {
      let o;
      try {
        o = await parseArgs(splitArgs(args ?? ""));
      } catch (e) {
        return ctx.ui.notify(String(e.message ?? e), "error");
      }
      const data = await ingest({ sinceMs: o.sinceMs, untilMs: o.untilMs, useIndex: o.useIndex });
      const catalog = catalogFromRegistry(ctx.modelRegistry);
      // Snapshot the live catalog so the offline CLI prices the same way.
      await mkdir(DEFAULT_STATE_DIR, { recursive: true });
      await writeFile(join(DEFAULT_STATE_DIR, "catalog.json"), JSON.stringify({ savedAt: new Date().toISOString(), models: catalog }));
      const bt = backtest(data, catalog, o);
      let text = textReport(data, bt);
      if (o.serve) {
        close();
        active = await serve(webPayload(data, bt, { catalogSource: "pi model registry" }));
        text += `\n\nWeb view: ${active.url}`;
        if (o.open) openUrl(active.url);
      }
      ctx.ui.notify(text, "info");
    },
  });
}
