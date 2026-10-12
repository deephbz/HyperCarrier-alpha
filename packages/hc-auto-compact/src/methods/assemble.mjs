// Assemble a compaction plan with budgeted conversation prose and selected output.
// Callers supply Pi's active context projection; raw hidden history stays outside.

// Compaction-local prose selection over Pi's active context projection.
function selectRarebits(entries) {
  const occurrences = [];
  for (const entry of entries) {
    const message = entry?.message;
    if (!["user", "assistant"].includes(message?.role)) continue;
    if (message.role === "assistant" && message.content?.some?.((b) => b.type === "toolCall")) continue;
    const text = typeof message.content === "string" ? message.content :
      (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (text.trim()) occurrences.push({ role: message.role, text });
  }
  return { occurrences };
}
import { estimateTokens } from "./manifest.mjs";

export const HANDOFF_CUSTOM_TYPE = "auto-compact.handoff";

const clip = (text, maxTokens) => {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[… truncated, ${estimateTokens(text) - maxTokens} more tokens omitted]`;
};

/**
 * Compaction-local conversation record. Select newest prose within the budget
 * and render it oldest-first. This does not implement Rarebit's public ontology.
 */
export function renderRarebitRecord(branch, { budgetTokens, includeCustomMessages = true }) {
  const visible = (branch ?? [])
    .filter((entry) => !(entry?.type === "custom_message" &&
      [HANDOFF_CUSTOM_TYPE, "auto-compact.pickup", "keepset.handoff"].includes(entry?.customType)))
    // Harness-delivered messages (e.g. PiTeams task and inbox deliveries) reach the model as user turns.
    .map((entry) =>
      includeCustomMessages && entry?.type === "custom_message"
        ? {
            type: "message",
            id: entry.id,
            timestamp: entry.timestamp,
            message: {
              role: "user",
              content: typeof entry.content === "string" ? [{ type: "text", text: entry.content }] : entry.content,
            },
          }
        : entry,
    );
  const { occurrences } = selectRarebits(visible);
  const picked = [];
  let used = 0;
  let omitted = 0;
  for (let i = occurrences.length - 1; i >= 0; i -= 1) {
    const occ = occurrences[i];
    const label = occ.role === "user" ? "USER" : "AGENT";
    const block = `[${label}]\n${occ.text.trim()}`;
    const cost = estimateTokens(block);
    if (used + cost > budgetTokens) {
      omitted += 1;
      continue;
    }
    used += cost;
    picked.push(block);
  }
  picked.reverse();
  const head = omitted ? [`[${omitted} older messages omitted for budget]`] : [];
  return { text: [...head, ...picked].join("\n\n"), tokens: used, count: picked.length, omitted };
}

/**
 * Resolve the agent's keep labels against the manifest, enforcing the budget
 * in the order the agent listed them. Unknown labels are reported, not fatal.
 */
export function resolveKeep(rounds, keepLabels, { budgetTokens, perItemTokens }) {
  const byLabel = new Map(rounds.map((round) => [round.label, round]));
  const kept = [];
  const unknown = [];
  const overBudget = [];
  let used = 0;
  for (const label of keepLabels ?? []) {
    const round = byLabel.get(String(label).trim());
    if (!round) {
      unknown.push(label);
      continue;
    }
    if (kept.includes(round)) continue;
    const cost = Math.min(round.tokens, perItemTokens);
    if (used + cost > budgetTokens) {
      overBudget.push(label);
      continue;
    }
    used += cost;
    kept.push(round);
  }
  kept.sort((a, b) => Number(a.label.slice(1)) - Number(b.label.slice(1)));
  return { kept, unknown, overBudget, tokens: used };
}

export function renderKeptRounds(kept, { perItemTokens }) {
  return kept
    .map(
      (round) =>
        `### ${round.label} · ${round.name} ${JSON.stringify(round.args)}${round.isError ? " (error)" : ""}\n` +
        "```\n" +
        clip(round.resultText, perItemTokens) +
        "\n```",
    )
    .join("\n\n");
}

export function renderDroppedIndex(dropped, stubPaths) {
  return dropped
    .map((round) => {
      const where = stubPaths.get(round.label);
      const args = JSON.stringify(round.args);
      return `- ${round.label} · ${round.name} ${args.length > 120 ? `${args.slice(0, 119)}…` : args} · ${round.tokens} tok${where ? ` · full output: ${where}` : ""}`;
    })
    .join("\n");
}

/** Bounded fork handoff record; undefined when the plan carries none. */
export function renderHandoffRecord(handoff, { budgetTokens, anchorEntryId }) {
  if (typeof handoff !== "string" || !handoff.trim()) return undefined;
  return {
    heading: `## Handoff record (written by the background compaction fork; state as of entry ${anchorEntryId ?? "A"}; later turns supersede it)`,
    text: clip(handoff.trim(), budgetTokens),
  };
}

export function assembleSummary({ planSummary, handoffRecord, rarebit, keptText, droppedText, mode }) {
  const parts = [
    "## Working-state summary (written by you just before compaction)",
    planSummary.trim() || "(no summary provided)",
    ...(handoffRecord ? [handoffRecord.heading, handoffRecord.text] : []),
    "## Conversation record (user messages and assistant prose)",
    rarebit.text || "(none)",
  ];
  if (mode === "keepset") {
    parts.push(
      "## Tool results you chose to keep (verbatim, captured before compaction — files may have changed since)",
      keptText || "(none kept)",
    );
  }
  parts.push(
    "## Dropped tool results (read the file path, where given, to recover the full output, or re-run the tool)",
    droppedText || "(none)",
  );
  return parts.join("\n\n");
}
