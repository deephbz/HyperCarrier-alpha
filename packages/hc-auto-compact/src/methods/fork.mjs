// Build the async compaction fork from the payload captured at point A.
//
// The fork stays content-identical through A to read the cache entry A wrote:
// same model, tools, system, thinking, effort messages, and markers. The handoff text is one new
// block after the marked tail block. Trailing content-free messages (pi's effort message) stay.

import { PLAN_TOOL } from "./plan-apply.mjs";

/** Last content block of the last non-empty, non-assistant message. */
export function findAnchor(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i].content;
    if (!Array.isArray(content) || content.length === 0) continue;
    if (messages[i].role !== "user") return null;
    return { messageIndex: i, blockIndex: content.length - 1 };
  }
  return null;
}

/**
 * @param {object} base payload captured at A; all payload modifiers must load before Auto Compact
 * @param {string} handoffText
 * @returns {{payload: object, anchor: {messageIndex: number, blockIndex: number}, anchorMarked: boolean}}
 */
export function buildForkPayload(base, handoffText) {
  const anchor = findAnchor(base.messages);
  if (!anchor) throw new Error("fork base has no user tail to anchor on");
  const message = base.messages[anchor.messageIndex];
  const anchorMarked = Boolean(message.content[anchor.blockIndex]?.cache_control);
  const messages = base.messages.slice();
  messages[anchor.messageIndex] = { ...message, content: [...message.content, { type: "text", text: handoffText }] };
  return { payload: { ...base, messages }, anchor, anchorMarked };
}

/**
 * Rebuild the raw Anthropic assistant content from stream events, so a follow-up request can
 * replay it exactly (thinking signatures included).
 */
export function createRawBlockCollector() {
  const blocks = [];
  const partialJson = new Map();
  return {
    push(event) {
      if (event?.type === "content_block_start") {
        blocks[event.index] = structuredClone(event.content_block);
        if (event.content_block?.type === "tool_use") partialJson.set(event.index, "");
      } else if (event?.type === "content_block_delta") {
        const block = blocks[event.index];
        const delta = event.delta ?? {};
        if (!block) return;
        if (delta.type === "text_delta") block.text = (block.text ?? "") + delta.text;
        else if (delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + delta.thinking;
        else if (delta.type === "signature_delta") block.signature = (block.signature ?? "") + delta.signature;
        else if (delta.type === "input_json_delta") partialJson.set(event.index, partialJson.get(event.index) + delta.partial_json);
      }
    },
    blocks() {
      return blocks.filter(Boolean).map((block, index) => {
        if (block.type !== "tool_use") return block;
        const json = partialJson.get(index);
        return json ? { ...block, input: JSON.parse(json) } : block;
      });
    },
  };
}

/**
 * Next fork request after the model called another tool: replay its reply and answer each
 * tool_use with an error result that asks for the plan. Trailing content-free messages
 * (pi's effort message) stay last.
 */
export function continueFork(payload, assistantBlocks, note) {
  const messages = payload.messages.slice();
  let end = messages.length;
  while (end > 0 && Array.isArray(messages[end - 1].content) && messages[end - 1].content.length === 0) end -= 1;
  const trailing = messages.slice(end);
  const results = assistantBlocks
    .filter((block) => block.type === "tool_use")
    .map((block) => ({ type: "tool_result", tool_use_id: block.id, is_error: true, content: note }));
  const reply = { role: "user", content: results.length ? results : [{ type: "text", text: note }] };
  return { ...payload, messages: [...messages.slice(0, end), { role: "assistant", content: assistantBlocks }, reply, ...trailing] };
}

/**
 * Read the plan from the fork's reply (a pi-ai AssistantMessage).
 * Text must contain one complete JSON object or one complete JSON code fence.
 * With `handoff`, the plan must also carry a nonempty handoff record string.
 * @returns {{summary: string, keep: string[], handoff?: string, source: "tool" | "json"} | null}
 */
export function readPlan(message, { handoff = false } = {}) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const call = content.find((block) => block?.type === "toolCall" && block.name === PLAN_TOOL);
  if (call) {
    return validatePlan(call.arguments, "tool", handoff);
  }
  // A call to another tool is not a plan; the caller asks again.
  if (content.some((block) => block?.type === "toolCall")) return null;
  const text = content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) return null;
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(text);
  let parsed;
  try { parsed = JSON.parse(fence ? fence[1] : text); }
  catch { throw new Error("invalid compaction plan: expected complete JSON"); }
  return validatePlan(parsed, "json", handoff);
}

function validatePlan(plan, source, handoff) {
  if (!plan || Array.isArray(plan) || typeof plan.summary !== "string" || !plan.summary.trim() ||
      !Array.isArray(plan.keep) || !plan.keep.every((label) => typeof label === "string"))
    throw new Error("invalid compaction plan: summary and keep must be complete");
  if (!handoff) return { summary: plan.summary, keep: [...plan.keep], source };
  if (typeof plan.handoff !== "string" || !plan.handoff.trim())
    throw new Error("invalid compaction plan: handoff must be a nonempty string");
  return { summary: plan.summary, keep: [...plan.keep], handoff: plan.handoff, source };
}

/**
 * Entry id that the installed compaction keeps from: the first branch entry after the anchor.
 * The plan covers only entries up to A, so it is invalid when A left the branch or another
 * compaction was installed after A.
 * @returns {{status: "ok", firstKeptEntryId: string|null} | {status: "anchor_missing" | "compacted_after_anchor"}}
 */
export function keptFrom(branch, anchorEntryId) {
  const index = branch.findIndex((entry) => entry.id === anchorEntryId);
  if (index < 0) return { status: "anchor_missing" };
  if (branch.slice(index + 1).some((entry) => entry.type === "compaction")) return { status: "compacted_after_anchor" };
  return { status: "ok", firstKeptEntryId: branch[index + 1]?.id ?? null };
}
