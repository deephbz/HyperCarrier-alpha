// Turn an agent's compaction plan into the compaction summary text and details.
// Foreground and background planning share this assembly path.

import { mkdirSync, writeFileSync } from "node:fs";
import { estimateTokens } from "./manifest.mjs";
import { assembleSummary, renderDroppedIndex, renderHandoffRecord, renderKeptRounds, renderRarebitRecord, resolveKeep } from "./assemble.mjs";

export const PLAN_TOOL = "compaction_plan";

/** Save each dropped round's full output under `dir`; returns label -> path. */
export function writeStubFiles(dir, dropped) {
  const paths = new Map();
  if (!dir) return paths;
  mkdirSync(dir, { recursive: true });
  for (const round of dropped) {
    const file = `${dir}/${round.label}.txt`;
    writeFileSync(file, `# ${round.name} ${JSON.stringify(round.args)}${round.isError ? " (error)" : ""}\n\n${round.resultText}`);
    paths.set(round.label, file);
  }
  return paths;
}

/**
 * @param {{summary: string, keep: string[], handoff?: string}} plan
 * @param {object[]} rounds manifest rounds the plan's labels refer to
 * @param {object[]} branchEntries entries the conversation record covers
 * @param {object} options keepset options (mode, budgets, includeCustomMessages, anchorEntryId)
 * @param {string|undefined} stubDir where dropped outputs are saved; undefined saves nothing
 * @returns {{summary: string, details: object}}
 */
export function applyPlan({ plan, rounds, branchEntries, options, stubDir }) {
  const { kept, unknown, overBudget, tokens: keptTokens } = resolveKeep(
    rounds,
    options.mode === "keepset" ? plan.keep : [],
    { budgetTokens: options.keepBudgetTokens, perItemTokens: options.perItemTokens },
  );
  const keptSet = new Set(kept.map((round) => round.label));
  const dropped = rounds.filter((round) => !keptSet.has(round.label) && round.name !== PLAN_TOOL);
  const stubPaths = writeStubFiles(stubDir, dropped);
  const rarebit = renderRarebitRecord(branchEntries, {
    budgetTokens: options.rarebitBudgetTokens,
    includeCustomMessages: options.includeCustomMessages,
  });
  const handoffRecord = renderHandoffRecord(plan.handoff, {
    budgetTokens: options.handoffBudgetTokens,
    anchorEntryId: options.anchorEntryId,
  });
  const summary = assembleSummary({
    planSummary: plan.summary,
    handoffRecord,
    rarebit,
    keptText: renderKeptRounds(kept, options),
    droppedText: renderDroppedIndex(dropped, stubPaths),
    mode: options.mode,
  });
  return {
    summary,
    details: {
      mode: options.mode,
      requested: plan.keep,
      kept: [...keptSet],
      unknown,
      overBudget,
      keptTokens,
      rarebitTokens: rarebit.tokens,
      rarebitCount: rarebit.count,
      planSummaryTokens: estimateTokens(plan.summary),
      ...(handoffRecord ? { handoffTokens: estimateTokens(handoffRecord.text) } : {}),
      summaryTokens: estimateTokens(summary),
      rounds: rounds.length,
    },
  };
}
