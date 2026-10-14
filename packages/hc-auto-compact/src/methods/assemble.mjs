// Assemble a compaction plan with budgeted conversation prose and selected output.
// Callers supply Pi's active context projection; raw hidden history stays outside.

import { selectRarebits } from "@hypercarrier/rarebit/core";
import { estimateTokens } from "./manifest.mjs";

const clip = (text, maxTokens) => {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[… truncated, ${estimateTokens(text) - maxTokens} more tokens omitted]`;
};

/** Select newest Rarebit prose within the budget and render it oldest-first. */
export function renderRarebitRecord(branch, { budgetTokens }) {
  const { occurrences } = selectRarebits(branch);
  const picked = [];
  let used = 0;
  let omitted = 0;
  for (let i = occurrences.length - 1; i >= 0; i -= 1) {
    const occ = occurrences[i];
    const text = occ.text.trim();
    if (!text) continue;
    const label = occ.role === "user" ? "USER" : "AGENT";
    const block = `[${label}]\n${text}`;
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

// A fence longer than any backtick run in the body keeps embedded fences and headings inside it.
const fence = (text) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

export function renderKeptRounds(kept, { perItemTokens }) {
  return kept
    .map((round) => {
      const body = clip(round.resultText, perItemTokens);
      const marker = fence(body);
      return `### ${round.label} · ${round.name} ${JSON.stringify(round.args)}${round.isError ? " (error)" : ""}\n` +
        `${marker}\n${body}\n${marker}`;
    })
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
export function renderHandoffRecord(handoff, { budgetTokens }) {
  if (typeof handoff !== "string" || !handoff.trim()) return undefined;
  return {
    heading: "## Handoff record (written by the background compaction fork; messages after this summary are newer and supersede it)",
    text: clip(handoff.trim(), budgetTokens),
  };
}

export function assembleSummary({ planSummary, handoffRecord, rarebit, keptText, droppedText, droppedSaved = false, mode }) {
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
    droppedSaved
      ? "## Dropped tool results (read the saved file where given, or re-run the tool)"
      : "## Dropped tool results (output not in context; repeat a read-only call if needed, never a mutating one)",
    droppedText || "(none)",
  );
  return parts.join("\n\n");
}
