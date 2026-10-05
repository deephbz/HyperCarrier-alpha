// Backtest assembly and plain-text report. Shared by CLI and extension.

import { POLICIES, SCENARIOS } from "./policies.mjs";
import { resolvePrices } from "./pricing.mjs";
import { actualLogged, actualRepriced, coverage, prepare, simulate } from "./sim.mjs";

export function backtest(data, catalog, { overrides = {} } = {}) {
  const prices = resolvePrices(data.models, catalog, overrides);
  const prep = prepare(data.rows, data.models);
  const results = SCENARIOS.map((s) => ({ scenario: s, ...simulate(prep, prices, s) }));
  const repriced = actualRepriced(prep, prices, data.warm);
  const logged = actualLogged(prep, data.warm);
  return { prices, prep, results, repriced, logged, coverage: coverage(prep, prices) };
}

/** Payload for the web view. The browser reruns sim.mjs so prices and policies stay editable. */
export function webPayload(data, bt, { catalogSource } = {}) {
  return {
    sinceMs: data.sinceMs,
    untilMs: data.untilMs,
    stats: { ...data.stats, sessions: data.sessions, requests: data.rows.length, warm: data.warm.length, linked: bt.prep.linked },
    models: data.models,
    prices: bt.prices,
    catalogSource,
    scenarios: SCENARIOS,
    policies: POLICIES,
    rows: data.rows,
    warm: data.warm,
  };
}

const usd = (n) => `$${n.toFixed(2)}`;
const pct = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const mtok = (n) => `${(n / 1e6).toFixed(1)}M`;
const share = (a, b) => `${((b ? a / b : 0) * 100).toFixed(1)}%`;

export function textReport(data, bt) {
  const base = bt.repriced.cost;
  const cov = bt.coverage;
  const fam = (t, f) => usd(t.byFamily[f] ?? 0).padStart(11);
  const lines = [
    `Window ${new Date(data.sinceMs).toISOString()} → ${new Date(data.untilMs).toISOString()}`,
    `${data.rows.length} requests · ${data.sessions} sessions · ${data.stats.scanned}/${data.stats.files} files (${data.stats.cached} cached) · ${data.stats.ms} ms`,
    `Scope: Anthropic + OpenAI models at API prices. Excluded ${mtok(cov.excluded)} tokens (${share(cov.excluded, cov.total)}): ${Object.keys(cov.excludedModels).join(", ") || "none"}`,
    "",
    `${"scenario".padEnd(24)}${"cost".padStart(11)}${"vs actual".padStart(11)}${"anthropic".padStart(11)}${"openai".padStart(11)}${"hit".padStart(9)}${"write".padStart(9)}`,
    `${"actual (logged)".padEnd(24)}${usd(bt.logged.cost).padStart(11)}${"".padStart(11)}${fam(bt.logged, "anthropic")}${fam(bt.logged, "openai")}`,
    `${"actual (API repriced)".padEnd(24)}${usd(base).padStart(11)}${"".padStart(11)}${fam(bt.repriced, "anthropic")}${fam(bt.repriced, "openai")}${mtok(bt.repriced.hit).padStart(9)}${mtok(bt.repriced.write).padStart(9)}`,
  ];
  for (const r of bt.results) {
    const d = base ? (r.cost - base) / base : 0;
    lines.push(`${r.scenario.label.padEnd(24)}${usd(r.cost).padStart(11)}${pct(d).padStart(11)}${fam(r, "anthropic")}${fam(r, "openai")}${mtok(r.hit).padStart(9)}${mtok(r.write).padStart(9)}`);
  }
  const est = data.models.filter((_, m) => bt.prep.group[m] && !bt.prep.reported[m]);
  if (est.length) lines.push("", `Estimated writes (route logs no cacheWrite; uncached input priced as writes): ${mtok(bt.repriced.estWrite)} tokens on ${est.join(", ")}`);
  if (cov.unpriced) lines.push(`Unpriced in-scope models (excluded): ${Object.keys(cov.unpricedModels).join(", ")}`);
  return lines.join("\n");
}
