// Tool-round manifest: one labelled row per tool call in the current context,
// so the agent can name the results it wants to keep by a short stable label.

export const estimateTokens = (text) => Math.ceil(String(text ?? "").length / 4);

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block?.type === "text") return block.text;
      if (block?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

const oneLine = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * Collect tool rounds (call + result) from context entries in order.
 * Returns [{ label, toolCallId, name, args, resultText, isError, tokens,
 *            callEntryId, resultEntryId }].
 */
export function collectToolRounds(entries) {
  const rounds = [];
  const byCallId = new Map();
  for (const entry of entries ?? []) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== "toolCall") continue;
        const round = {
          label: `t${rounds.length + 1}`,
          toolCallId: block.id,
          name: block.name,
          args: block.arguments ?? {},
          resultText: "",
          isError: false,
          tokens: 0,
          callEntryId: entry.id,
          resultEntryId: null,
        };
        rounds.push(round);
        byCallId.set(block.id, round);
      }
    } else if (message?.role === "toolResult") {
      const round = byCallId.get(message.toolCallId);
      if (!round) continue;
      round.resultText = textOf(message.content);
      round.isError = Boolean(message.isError);
      round.resultEntryId = entry.id;
    }
  }
  for (const round of rounds) {
    round.tokens = estimateTokens(round.resultText) + estimateTokens(JSON.stringify(round.args));
  }
  return rounds;
}

/** Drop rounds that cannot matter: reads superseded by a later write/edit of the same path. */
export function markSuperseded(rounds) {
  const lastWrite = new Map();
  rounds.forEach((round, index) => {
    const path = round.args?.path ?? round.args?.file_path;
    if (path && (round.name === "write" || round.name === "edit")) lastWrite.set(path, index);
  });
  return rounds.map((round, index) => {
    const path = round.args?.path ?? round.args?.file_path;
    const superseded =
      round.name === "read" && path && lastWrite.has(path) && lastWrite.get(path) > index;
    return { ...round, superseded: Boolean(superseded) };
  });
}

export function renderManifest(rounds, { budgetTokens }) {
  const lines = rounds
    .filter((round) => round.name !== "compaction_plan")
    .map((round) => {
      const flags = [round.isError ? "error" : null, round.superseded ? "superseded" : null]
        .filter(Boolean)
        .join(",");
      const size = round.tokens >= 1000 ? `${(round.tokens / 1000).toFixed(1)}k` : `${round.tokens}`;
      return `${round.label} | ${round.name} | ${oneLine(JSON.stringify(round.args), 100)} | ${size} tok${flags ? ` | ${flags}` : ""}`;
    });
  return [
    `Keep budget: ${budgetTokens} tokens in total.`,
    "label | tool | arguments | size | flags",
    ...lines,
  ].join("\n");
}
