// Executable projection of the perceptual contract in ../VISUAL-LANGUAGE.md.
// Consumers own layout and renderer-specific styling; this module owns semantic
// marks, labels, tones, and source-pending attention gating.

export const RAREBIT_EVENT_PRESENTATION = Object.freeze({
  user_message: Object.freeze({
    mark: "□",
    label: "user message",
    tone: "user",
    salience: "standard",
  }),
  agent_continuation: Object.freeze({
    mark: "•",
    label: "agent continues",
    tone: "continuation",
    salience: "smaller",
  }),
  agent_stop: Object.freeze({
    mark: "●",
    label: "agent stops",
    tone: "boundary",
    salience: "larger",
  }),
  terminal_error: Object.freeze({
    mark: "×",
    label: "terminal error",
    tone: "diagnostic",
    salience: "diagnostic",
  }),
});

export const RAREBIT_SUMMARY_PRESENTATION = Object.freeze({
  user_requested: Object.freeze({
    mark: null,
    label: "request recorded",
    tone: "neutral",
    salience: "ordinary",
  }),
  finished: Object.freeze({
    mark: null,
    label: "appears finished",
    tone: "neutral",
    salience: "ordinary",
  }),
  needs_attention: Object.freeze({
    mark: "◆!",
    label: "needs you",
    tone: "attention",
    salience: "attention",
  }),
  ineligible: Object.freeze({
    mark: null,
    label: "ineligible",
    tone: "muted",
    salience: "muted",
  }),
  error: Object.freeze({
    mark: "×",
    label: "error",
    tone: "diagnostic",
    salience: "diagnostic",
  }),
});

function requiredPresentation(table, key, noun) {
  const presentation = table[key];
  if (!presentation) throw new TypeError(`Unknown Rarebit ${noun}: ${key}`);
  return presentation;
}

export function rarebitEventPresentation(kind) {
  return requiredPresentation(RAREBIT_EVENT_PRESENTATION, kind, "event kind");
}

export function rarebitOccurrencePresentation(occurrence) {
  if (occurrence?.role === "user")
    return rarebitEventPresentation("user_message");
  if (
    occurrence?.role === "assistant" &&
    occurrence?.outcome === "continuation"
  )
    return rarebitEventPresentation("agent_continuation");
  if (occurrence?.role === "assistant" && occurrence?.outcome === "stop")
    return rarebitEventPresentation("agent_stop");
  throw new TypeError(
    `Unknown Rarebit occurrence role/outcome: ${occurrence?.role ?? "missing"}/${occurrence?.outcome ?? "missing"}`,
  );
}

export function rarebitSummaryPresentation(
  status,
  { sourcePending = false } = {},
) {
  const presentation = requiredPresentation(
    RAREBIT_SUMMARY_PRESENTATION,
    status,
    "Summary status",
  );
  if (!sourcePending) return presentation;
  return Object.freeze({
    ...presentation,
    mark: null,
    label: `${presentation.label} · source pending`,
    tone: presentation.tone === "attention" ? "neutral" : presentation.tone,
    salience:
      presentation.salience === "attention"
        ? "ordinary"
        : presentation.salience,
  });
}
