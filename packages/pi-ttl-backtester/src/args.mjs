// Shared argument parsing for the CLI and the /ttl-backtest command.
//
//   [since] [until]             7d | 12h | 2026-09-01 | ISO timestamp (default since: 7d, until: now)
//   --prices file.json          price overrides { "<provider/model>|<model>": { input, output, cacheRead, cacheWrite } }
//   --no-serve / --no-open      skip web view / skip opening a browser
//   --no-index                  ignore the ingest index cache

import { readFile } from "node:fs/promises";
import { parseDuration } from "./sim.mjs";

export function parseTime(v, now = Date.now()) {
  if (/^[\d.]+\s*[smhd]$/.test(v)) return now - parseDuration(v) * 1000;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v);
  if (!Number.isFinite(t)) throw new Error(`Bad time: ${v}`);
  return t;
}

export async function parseArgs(argv) {
  const pos = [];
  const o = { serve: true, open: true, useIndex: true, overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prices") o.overrides = JSON.parse(await readFile(argv[++i], "utf8"));
    else if (a === "--no-serve") o.serve = false;
    else if (a === "--no-open") o.open = false;
    else if (a === "--no-index") o.useIndex = false;
    else pos.push(a);
  }
  const now = Date.now();
  o.sinceMs = parseTime(pos[0] ?? "7d", now);
  o.untilMs = pos[1] ? parseTime(pos[1], now) : now;
  return o;
}

export function splitArgs(s) {
  return (s.match(/"[^"]*"|\S+/g) ?? []).map((x) => x.replace(/^"|"$/g, ""));
}
