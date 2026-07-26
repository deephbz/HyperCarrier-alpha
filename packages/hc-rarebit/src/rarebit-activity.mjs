// Native Rarebit selection is the source of these recency coordinates. This
// module deliberately has no clock or renderer: consumers choose how (and
// whether) to project an age from an exact active-branch snapshot.

function latest(occurrences, matches) {
  for (let index = occurrences.length - 1; index >= 0; index -= 1) {
    const occurrence = occurrences[index];
    if (!matches(occurrence)) continue;
    return Object.freeze({
      sourceEntryId: occurrence.sourceEntryId ?? null,
      timestamp:
        typeof occurrence.timestamp === "string" ? occurrence.timestamp : null,
    });
  }
  return null;
}

/**
 * Projects the latest selected user-role and normal assistant-stop evidence.
 * "Latest" is active-branch order, not a clock-sorted guess. A missing or
 * invalid native timestamp stays unavailable to a renderer; callers must not
 * substitute materialization time, mtime, or an earlier occurrence.
 */
export function projectRarebitSessionActivity(selection) {
  const occurrences = Array.isArray(selection?.occurrences)
    ? selection.occurrences
    : [];
  return Object.freeze({
    schemaVersion: 1,
    selectorVersion:
      typeof selection?.manifest?.selectorVersion === "string"
        ? selection.manifest.selectorVersion
        : null,
    selectionManifestHash:
      typeof selection?.manifestHash === "string"
        ? selection.manifestHash
        : null,
    latestUser: latest(
      occurrences,
      (occurrence) => occurrence?.role === "user",
    ),
    latestAgentStop: latest(
      occurrences,
      (occurrence) =>
        occurrence?.role === "assistant" && occurrence?.outcome === "stop",
    ),
  });
}
