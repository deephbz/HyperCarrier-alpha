// This classifier deliberately returns only Timeline-safe metadata. It may
// inspect native Pi message content to apply the same predicate as summary
// materialization, but it never returns content or a content-derived hash.
export const KEY_MESSAGE_SELECTOR_VERSION = "key-message-selector-v1";

function textBlocks(message) {
  if (typeof message?.content === "string") return [message.content];
  return Array.isArray(message?.content)
    ? message.content
        .filter(
          (block) =>
            block &&
            typeof block === "object" &&
            block.type === "text" &&
            typeof block.text === "string",
        )
        .map((block) => block.text)
    : [];
}

/**
 * Classifies exactly the message records that Key Message Summary selects.
 *
 * The returned shape is safe for a fleet metadata projection: no message
 * text, tool input/output, reasoning, or content hashes leave this boundary.
 */
export function keyMessageMetadata(entry, order = 0) {
  const message = entry?.type === "message" ? entry.message : undefined;
  if (!message || textBlocks(message).length === 0) return null;

  let outcome;
  if (message.role === "user") outcome = "user";
  else if (message.role === "assistant" && message.stopReason === "stop")
    outcome = "stop";
  else if (message.role === "assistant" && message.stopReason === "toolUse")
    outcome = "continuation";
  else return null;

  return {
    sourceEntryId:
      typeof entry.id === "string"
        ? entry.id
        : typeof message.id === "string"
          ? message.id
          : null,
    order,
    role: message.role,
    outcome,
    producer:
      typeof entry.producer === "string"
        ? entry.producer
        : typeof message.producer === "string"
          ? message.producer
          : null,
    timestamp:
      typeof entry.timestamp === "string"
        ? entry.timestamp
        : typeof message.timestamp === "string"
          ? message.timestamp
          : null,
  };
}

export function keyMessageText(entry) {
  const message = entry?.type === "message" ? entry.message : undefined;
  return textBlocks(message).join("\n");
}
