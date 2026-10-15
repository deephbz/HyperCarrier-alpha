// Place Anthropic prompt-cache markers on a Messages API payload.
//
// Layout, in prefix order (Anthropic renders tools, then system, then messages):
//   [tools][system: global layer] G [system: project layer] P [messages ... pins ...] T
// G and P use the layer TTL (1h). Pins and the tail T use the session TTL (5m or 1h).
// Anthropic allows at most 4 markers and rejects a longer TTL after a shorter one.

import { createHash } from "node:crypto";

export const MAX_MARKERS = 4;
export const TTLS = Object.freeze(["5m", "1h"]);
const TTL_RANK = { "5m": 1, "1h": 2 };
// Block types pi itself marks (pi-ai anthropic-messages.js, last-user-message marker).
const MARKABLE = new Set(["text", "image", "document", "tool_result", "tool_addition", "tool_removal"]);
// Pi 1.1/1.2 Messages transcripts append prompt and tool transitions in system
// messages. Keep their native text, tool_addition and tool_removal blocks cacheable.
// Unknown system content stays outside the recognizable Messages contract.
const SYSTEM_CONTENT_TYPES = new Set(["text", "tool_addition", "tool_removal"]);
const CONTENT_TYPES = new Set([...MARKABLE, "tool_use", "thinking", "redacted_thinking", "server_tool_use",
  "web_search_tool_result", "web_fetch_tool_result", "code_execution_tool_result", "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result", "container_upload"]);

export function isAnthropicMessagesPayload(payload) {
  return (
    payload !== null &&
    typeof payload === "object" &&
    typeof payload.model === "string" &&
    Array.isArray(payload.messages) &&
    Number.isSafeInteger(payload.max_tokens) && payload.max_tokens > 0 &&
    !["input", "response_format", "functions", "generationConfig"].some((key) => key in payload) &&
    (typeof payload.system === "string" || (Array.isArray(payload.system) && payload.system.length > 0 &&
      payload.system.every((block) => block?.type === "text" && typeof block.text === "string"))) &&
    (!payload.tools || (Array.isArray(payload.tools) && payload.tools.every((tool) =>
      tool && typeof tool === "object" && tool.type !== "function" && (tool.input_schema || typeof tool.type === "string")))) &&
    payload.messages.every((message) => message && ["user", "assistant", "system"].includes(message.role) &&
      (message.role !== "system" || (Array.isArray(message.content) &&
        message.content.every((block) => SYSTEM_CONTENT_TYPES.has(block?.type)))) &&
      (typeof message.content === "string" || (Array.isArray(message.content) && message.content.every((block) =>
        block && typeof block === "object" && CONTENT_TYPES.has(block.type) &&
        (block.type !== "text" || typeof block.text === "string")))))
  );
}

const withoutMarker = (block) => {
  if (!block || typeof block !== "object" || !("cache_control" in block)) return block;
  const { cache_control: _dropped, ...rest } = block;
  return rest;
};

const contentArray = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : content);

/** Deep-copy the parts we edit and remove every existing marker. */
export function stripMarkers(payload) {
  const out = { ...payload };
  if (Array.isArray(payload.tools)) out.tools = payload.tools.map(withoutMarker);
  if (typeof payload.system === "string") out.system = [{ type: "text", text: payload.system }];
  else if (Array.isArray(payload.system)) out.system = payload.system.map(withoutMarker);
  out.messages = payload.messages.map((message) =>
    Array.isArray(message.content) || typeof message.content === "string"
      ? { ...message, content: contentArray(message.content).map(withoutMarker) }
      : { ...message },
  );
  delete out.cache_control; // top-level automatic caching would add a 5th marker
  return out;
}

/** Conservative request-head fingerprint, independent of marker layout and output cap. */
export function headOf(payload) {
  // Keep unknown request-head fields: new provider cache keys must invalidate pins too.
  const { messages: _messages, max_tokens: _cap, stream: _stream, ...head } = stripMarkers(payload);
  if (Array.isArray(head.system)) {
    head.system = head.system.reduce((blocks, block) => {
      const previous = blocks.at(-1);
      const { text, ...metadata } = block;
      const { text: previousText, ...previousMetadata } = previous ?? {};
      if (block.type === "text" && previous?.type === "text" &&
          JSON.stringify(metadata) === JSON.stringify(previousMetadata)) {
        blocks[blocks.length - 1] = { ...previous, text: previousText + text };
      } else blocks.push(block);
      return blocks;
    }, []);
  }
  return head;
}

/**
 * Hash of the request prefix that ends at (messageIndex, blockIndex), markers excluded.
 * `head` (from headOf) covers all request-head fields except stream and output cap: a change there invalidates
 * every message-level cache entry. Two requests with the same hash at a position share the
 * cache entry written there.
 */
export function prefixHash(messages, { messageIndex, blockIndex }, head = {}) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(head));
  for (let i = 0; i < messageIndex; i += 1) hash.update(JSON.stringify(stripMessage(messages[i])));
  const last = stripMessage(messages[messageIndex]);
  hash.update(JSON.stringify({ ...last, content: last.content.slice(0, blockIndex + 1) }));
  return hash.digest("hex");
}

const stripMessage = (message) =>
  Array.isArray(message?.content) || typeof message?.content === "string"
    ? { ...message, content: contentArray(message.content).map(withoutMarker) }
    : { ...message, content: [] };

/**
 * The last markable block of the conversation. Trailing content-free messages (pi's
 * `{role:"system", content:[], output_config}` effort message) are skipped.
 */
export function findTail(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i].content;
    if (!Array.isArray(content) || content.length === 0) continue;
    if (messages[i].role === "assistant") return null;
    const blockIndex = content.length - 1;
    return MARKABLE.has(content[blockIndex]?.type) ? { messageIndex: i, blockIndex } : null;
  }
  return null;
}

const samePosition = (a, b) => a && b && a.messageIndex === b.messageIndex && a.blockIndex === b.blockIndex;

const blockAt = (messages, { messageIndex, blockIndex }) => messages[messageIndex]?.content?.[blockIndex];

/** Throws when a marker with a longer TTL follows one with a shorter TTL. */
export function assertTtlOrder(markers) {
  for (let i = 1; i < markers.length; i += 1) {
    if (TTL_RANK[markers[i].ttl] > TTL_RANK[markers[i - 1].ttl]) {
      throw new Error(`cache marker TTL order: ${markers[i].layer} ${markers[i].ttl} after ${markers[i - 1].layer} ${markers[i - 1].ttl}`);
    }
  }
}

/**
 * @param {object} payload Anthropic Messages payload (not mutated)
 * @param {object} plan
 * @param {"5m"|"1h"} plan.sessionTtl TTL for pins and the tail
 * @param {"5m"|"1h"} [plan.layerTtl] TTL for the global and project system layers
 * @param {(text: string) => number} [plan.globalBoundary] offset where the global layer ends, or -1
 * @param {{name: string, at?: {messageIndex: number, blockIndex: number, hash: string}}[]} [plan.pins]
 *   newest wins; a pin without `at` resolves to the tail unless capturePending is false
 * @param {boolean} [plan.capturePending] false prevents replay from capturing a new pin
 * @returns {{ payload: object, markers: object[], pins: object[] }}
 *   markers in prefix order: {layer, ttl, system?: index, messageIndex?, blockIndex?, name?}
 *   pins: {name, at, status: "placed" | "stale" | "dropped" | "unresolved"}
 */
export function placeMarkers(payload, plan) {
  const sessionTtl = plan.sessionTtl;
  const layerTtl = plan.layerTtl ?? "1h";
  if (!TTL_RANK[sessionTtl] || !TTL_RANK[layerTtl]) throw new Error(`unknown cache TTL: ${sessionTtl}/${layerTtl}`);
  if (TTL_RANK[layerTtl] < TTL_RANK[sessionTtl]) throw new Error("layer TTL must be >= session TTL");

  const out = stripMarkers(payload);
  const head = headOf(payload);
  const layerMarkers = [];
  if (Array.isArray(out.system) && out.system.length > 0) {
    const system = [];
    let split = false;
    for (const block of out.system) {
      const at = !split && block.type === "text" && plan.globalBoundary ? plan.globalBoundary(block.text) : -1;
      if (at > 0 && at < block.text.length) {
        system.push({ ...block, text: block.text.slice(0, at) }, { ...block, text: block.text.slice(at) });
        layerMarkers.push({ layer: "global", ttl: layerTtl, system: system.length - 2 });
        split = true;
      } else {
        system.push(block);
        if (at === block.text?.length) {
          layerMarkers.push({ layer: "global", ttl: layerTtl, system: system.length - 1 });
          split = true;
        }
      }
    }
    out.system = system;
    if (layerMarkers[0]?.system !== system.length - 1) {
      layerMarkers.push({ layer: "project", ttl: layerTtl, system: system.length - 1 });
    }
  }

  const messages = out.messages;
  const tail = findTail(messages);
  const pinResults = [];
  const pinMarkers = [];
  for (const pin of plan.pins ?? []) {
    if (!pin || typeof pin.name !== "string" || !pin.name.trim()) continue;
    if (pinResults.length) {
      for (const previous of pinResults) {
        if (previous.status === "placed" || previous.status === "unresolved") previous.status = "dropped";
      }
      pinMarkers.length = 0;
    }
    if (pin.at !== undefined && (!pin.at || !Number.isSafeInteger(pin.at.messageIndex) ||
        pin.at.messageIndex < 0 || !Number.isSafeInteger(pin.at.blockIndex) || pin.at.blockIndex < 0 ||
        typeof pin.at.hash !== "string" || !/^[a-f0-9]{64}$/.test(pin.at.hash))) {
      pinResults.push({ name: pin.name, status: "stale" });
      continue;
    }
    if (!pin.at) {
      if (!tail || plan.capturePending === false) {
        pinResults.push({ name: pin.name, status: "unresolved" });
        continue;
      }
      const at = { ...tail, hash: prefixHash(messages, tail, head) };
      pinResults.push({ name: pin.name, at, status: "placed" });
      continue; // shares the tail marker on this request
    }
    const block = blockAt(messages, pin.at);
    if (!block || messages[pin.at.messageIndex]?.role === "assistant" || !MARKABLE.has(block.type) || prefixHash(messages, pin.at, head) !== pin.at.hash) {
      pinResults.push({ name: pin.name, at: pin.at, status: "stale" });
      continue;
    }
    const result = { name: pin.name, at: pin.at, status: "placed" };
    pinResults.push(result);
    if (samePosition(pin.at, tail) || pinMarkers.some((m) => samePosition(m, pin.at))) continue;
    pinMarkers.push({ layer: "pin", ttl: sessionTtl, name: pin.name, messageIndex: pin.at.messageIndex, blockIndex: pin.at.blockIndex, result });
  }

  const tailMarkers = tail ? [{ layer: "tail", ttl: sessionTtl, ...tail }] : [];
  // Over budget: drop the oldest pins first; layers and the tail stay.
  const room = MAX_MARKERS - layerMarkers.length - tailMarkers.length;
  while (pinMarkers.length > Math.max(0, room)) {
    const dropped = pinMarkers.shift();
    dropped.result.status = "dropped";
  }
  pinMarkers.sort((a, b) => a.messageIndex - b.messageIndex || a.blockIndex - b.blockIndex);

  const markers = [...layerMarkers, ...pinMarkers.map(({ result: _r, ...m }) => m), ...tailMarkers];
  assertTtlOrder(markers);

  const control = (ttl) => ({ type: "ephemeral", ttl });
  for (const marker of markers) {
    if (marker.system !== undefined) {
      out.system[marker.system] = { ...out.system[marker.system], cache_control: control(marker.ttl) };
    } else {
      const message = messages[marker.messageIndex];
      const content = message.content.slice();
      content[marker.blockIndex] = { ...content[marker.blockIndex], cache_control: control(marker.ttl) };
      messages[marker.messageIndex] = { ...message, content };
    }
  }
  return { payload: out, markers, pins: pinResults };
}
