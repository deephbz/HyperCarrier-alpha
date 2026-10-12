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
