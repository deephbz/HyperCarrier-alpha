const AGENT_INSTRUCTION_LABEL =
  "Agent instruction (framework-generated hidden context; not user input):";

function stageLabel(name, status) {
  switch (status) {
    case "active":
      return `● ${name} (active)`;
    case "done":
      return `✓ ${name}`;
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
  return `${title}\n${rail}\n${receipt.outcome}${prompt}`;
}

export function renderLifecycleHud(
  receipt,
  { state, externalResolution = false },
) {
  const trigger = receipt.trigger === "manual" ? "MANUAL" : "AUTOMATIC";
  const phase = externalResolution
    ? "EXTERNAL COMPACTION — resolving interrupted handoff"
    : state === "queued"
      ? "QUEUED — waiting behind current agent work"
      : state === "handoff_pending"
        ? "HANDOFF — awaiting readiness"
        : state === "ready"
          ? "READY — awaiting turn end"
          : state === "compacting"
            ? "COMPACTING"
            : "PICKUP — requesting continuation";
  return `AUTO COMPACT · ${trigger} · ${phase}`;
}
