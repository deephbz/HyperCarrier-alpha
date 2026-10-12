export function compactTokens(value) {
  if (!Number.isFinite(value)) return "unavailable";
  const scale = Math.abs(value) >= 1e6 ? 1e6 : Math.abs(value) >= 1e3 ? 1e3 : 1;
  return `${Number((value / scale).toFixed(1))}${scale === 1e6 ? "M" : scale === 1e3 ? "k" : ""}`;
}
const percent = (value) => Number.isFinite(value) ? `${Number(value.toFixed(2))}%` : "unavailable";

const SWITCH_HINT = "Switch: /auto-compact fg|bg · method native|summary|keepset · preservation artifact-handoff|none";

// The controller supplies facts. This view has no settings or lifecycle effects.
export function renderStatus(view = {}) {
  const next = view.next ?? {};
  const selected = view.active ?? next;
  const overrides = view.overrides ?? {};
  const row = (label, text) => `  ${label.padEnd(8)} ${text}`;
  const selection = (settings, temporary) => ["method", "execution", "preservation"]
    .map((key) => `${settings[key] ?? "unavailable"}${temporary && Object.hasOwn(overrides, key) ? "*" : ""}`).join(" · ");
  const budget = view.budget ?? {};
  const source = { "Session override": "branch override", budget_tokens: "settings", "model.contextWindow": "model window" }[budget.source] ?? budget.source ?? "unavailable";
  const lines = [`Auto Compact · ${view.failed ? "DISARMED" : next.enabled ? "ON" : "OFF"} · ${view.state ?? "unavailable"}${!next.enabled ? " · native budget enforcement still applies" : ""}`];
  if (view.failure) lines.push(`⚠ ${view.failure}`);
  if (view.rearm) lines.push(`→ ${view.rearm}`);
  lines.push(row("context", `${percent(view.usage?.percent)} · ${compactTokens(view.usage?.tokens)} of ${compactTokens(budget.window)} · trigger ${percent(next.threshold)} (${compactTokens(budget.window * next.threshold / 100)})`));
  // OFF runs plain native compaction, so the saved strategy is only a selection.
  lines.push(row(next.enabled ? "next" : "selected", selection(next, true)));
  if (view.active) lines.push(row("active", `${selection(view.active, false)} · threshold ${percent(view.active.threshold)} · policy ${view.active.enabled ? "on" : "off"}`));
  lines.push(row("budget", `${compactTokens(budget.configured)} (${source})${budget.clamped ? ` · clamped to model window ${compactTokens(budget.window)}` : ""} · ${selected.preservation === "none" ? "planning" : "handoff"} room ${compactTokens(view.room)}`));
  lines.push(row("mode", view.mode ?? "unavailable"));
  if (view.phase) lines.push(row("phase", view.phase));
  if (view.heldCount) lines.push(row("input", `${view.heldCount} held`));
  if (view.nativeLimits) {
    lines.push(row("limits", `${selected.execution === "background" ? `background output cap ${view.outputCap === null ? "none (provider default)" : compactTokens(view.outputCap)} · ` : ""}summary caps history ${compactTokens(view.caps?.history)} · turn prefix ${compactTokens(view.caps?.prefix)} · reserve ${compactTokens(view.caps?.reserve)}`));
  } else lines.push(row("limits", `output ceiling ${compactTokens(view.outputCeiling)} (Session request settings apply)`));
  if (view.last) {
    const last = view.last;
    lines.push(row("last", last.error ? `failed: ${last.error}` : `compacted from ${compactTokens(last.tokensBefore)}${last.aggregate === true ? " · split-turn summary (aggregate usage)" : ""}`));
    if (last.caps) lines.push(row("last cap", Object.entries(last.caps).map(([key, value]) => `${key} ${compactTokens(value)}`).join(" · ")));
    if (last.usage) {
      const usageParts = [];
      for (const [key, value] of Object.entries(last.usage)) {
        if (value && typeof value === "object") {
          for (const [part, amount] of Object.entries(value)) usageParts.push(`${key} ${part} ${Number.isFinite(amount) ? amount : "unavailable"}`);
        } else usageParts.push(`${key} ${compactTokens(value)}`);
      }
      lines.push(row("usage", usageParts.join(" · ")));
    }
  }
  if (Object.keys(overrides).length) lines.push("* temporary: resets on /reload or Session switch (Session selection)");
  for (const error of view.errors ?? []) lines.push(`⚠ Invalid settings: ${error}`);
  for (const warning of view.warnings ?? []) lines.push(`⚠ ${warning}`);
  for (const hint of view.hints ?? []) lines.push(`→ ${hint}`);
  lines.push(`→ ${SWITCH_HINT}`);
  if (view.receipt) lines.push("", renderHumanReceipt(view.receipt, { heading: view.receiptHeading, includePrompt: true }));
  else lines.push("", "No Auto Compact run this Session");
  return lines.join("\n");
}

const AGENT_INSTRUCTION_LABEL =
  "Agent instruction (framework-generated hidden context; not user input):";

function stageLabel(name, status) {
  switch (status) {
    case "active":
      return `● ${name} (active)`;
    case "done":
      return `✓ ${name}`;
    case "skipped":
      return `— ${name} (skipped)`;
    case "failed":
      return `× ${name} (failed)`;
    case "interrupted":
      return `↷ ${name} (interrupted)`;
    case "external_done":
      return `✓ ${name} (external)`;
    case "pending":
      return `○ ${name}`;
    case "not_requested":
    default:
      return `— ${name}`;
  }
}

export function renderHumanReceipt(
  receipt,
  { heading, includePrompt = false } = {},
) {
  const title = [
    "AUTO COMPACT",
    receipt.trigger === "manual" ? "MANUAL" : "AUTOMATIC",
    heading,
  ]
    .filter(Boolean)
    .join(" · ");
  const rail = [
    stageLabel("HANDOFF", receipt.handoff),
    stageLabel("COMPACT", receipt.compact),
    stageLabel("PICKUP", receipt.pickup),
  ].join(" → ");
  const prompt =
    includePrompt && receipt.instructionRequested
      ? `\n\n${AGENT_INSTRUCTION_LABEL}\n${receipt.prompt}`
      : "";
  const forced = receipt.forced
    ? receipt.overshootTokens === undefined
      ? "\nForced: handoff settled without readiness."
      : `\nForced at budget; overshoot ${receipt.overshootTokens} tokens.`
    : "";
  return `${title}\n${rail}\n${receipt.outcome}${forced}${prompt}`;
}

export function renderLifecycleHud(
  receipt,
  { state, externalResolution = false, methodPhase },
) {
  const trigger = receipt.trigger === "manual" ? "MANUAL" : "AUTOMATIC";
  const phase = externalResolution
    ? "EXTERNAL COMPACTION — resolving interrupted handoff"
    : state === "queued"
      ? `${receipt.preservation === "none" ? "QUEUED PLANNING" : "QUEUED"} — waiting behind current agent work`
      : methodPhase && ["handoff_pending", "ready"].includes(state)
        ? `${receipt.preservation === "none" ? "PLANNING" : "HANDOFF / PLANNING"} — ${methodPhase}`
      : state === "handoff_pending"
        ? "HANDOFF — awaiting readiness"
        : state === "ready"
          ? "READY — awaiting turn end"
          : state === "compacting"
            ? "COMPACTING"
            : "PICKUP — requesting continuation";
  return `AUTO COMPACT · ${trigger} · ${phase}`;
}
