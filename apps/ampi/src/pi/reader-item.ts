// The Pi side of ReaderItem (docs/durable/reader-design.md, "Mapping"): one bridge turns each native Pi entry into the
// reader's entry plus the published semantics the hub derives from. Hub consumers read only ReaderItem, so a
// durable source supplies the same shape from its own bridge, and no consumer parses native Pi payloads.
import { selectRarebits, measureRarebits } from "@hypercarrier/rarebit/core";
// @ts-ignore shared native extraction is plain ESM
import { mirrorEntryText } from "../../../trace-analytics/src/sources/transcript.mjs";
import type { PiReaderEntry } from "./views/types.ts";
import type { Kinds, RarebitItem } from "./views/rarebit.ts";

/** `data`: the entry's structured data, which a durable source carries beside the entry (its `source.data`). */
export type ReaderItem<S> = { entry: PiReaderEntry; position: number; semantics: S; data?: unknown };

/** Rarebit's selector output for one entry, kept as the working set stores it. */
export type RarebitOccurrence = { sourceEntryId: string | null; outcome: "user" | "stop" | "continuation"; timestamp: string | null; text: string };

/** The per-entry record Rarebit's lineage reader and the model head read back from the working set. */
export type LineageRecord = {
 id: string; type: string;
 /** Provider-qualified, set only on a model change. */
 model?: string;
 rarebitFork?: { version: unknown; kind: unknown };
 customType?: string;
 data?: { schemaVersion: unknown; opening: { seedEntryId: unknown }; importedEntryIds: unknown };
};

export type IngestSemantics = {
 /** occurrence is the selector's first occurrence before the human-turn filter; item is the Rarebit view's mark. */
 rarebit: { occurrence: RarebitOccurrence | null; item: RarebitItem | null; totalMessageProseChars: number; rarebitChars: number };
 proseCounts: Kinds;
 lineage: LineageRecord;
};

export type FindSemantics = { findText: string };

export const emptyKinds = (): Kinds => ({ user: 0, continuation: 0, stop: 0, toolCalls: 0, toolResults: 0, thinking: 0, summary: 0, other: 0 });

type PiRow = { native: any; entry: PiReaderEntry; position: number; source?: { data?: unknown } };
type PiRange = { visit(fn: (row: PiRow) => void, options?: { after?: string | null }): void };

function ingest({ native, entry: e }: PiRow): IngestSemantics {
 const selection = selectRarebits([native]);
 const occurrence = selection.occurrences[0];
 if (occurrence?.outcome === "user" && e.kind !== "human") selection.occurrences = [];
 const chosen = selection.occurrences[0];
 const measurement = measureRarebits([native], selection) as { totalMessageProseChars: number; rarebitChars: number };
 let item: RarebitItem | null = chosen?.sourceEntryId ? { id: chosen.sourceEntryId, kind: chosen.outcome, t: chosen.timestamp, text: chosen.text } as RarebitItem : null;
 if (e.kind === "compaction" || e.kind === "reset") item = { id: e.id, kind: "compaction", t: native.timestamp ?? null, text: "Context restarts here" };
 if (e.role === "assistant" && e.stop === "error") item = { id: e.id, kind: "error", t: native.timestamp ?? null, text: e.error || "The agent reported a terminal error." };
 const chars = emptyKinds();
 if (native.type === "compaction") chars.summary += String(native.summary ?? "").length;
 const m = native.message;
 for (const b of typeof m?.content === "string" ? [{ type: "text", text: m.content }] : m?.content ?? []) {
  if (b.type === "thinking") chars.thinking += String(b.thinking ?? b.text ?? "").length;
  else if (b.type === "toolCall") chars.toolCalls += JSON.stringify(b.arguments ?? b.args ?? {}).length + String(b.name ?? "").length;
  else if (b.type === "text") chars[m.role === "toolResult" ? "toolResults" : chosen?.outcome as keyof Kinds ?? "other"] += String(b.text ?? "").length;
 }
 const lineage: LineageRecord = { id: native.id, type: native.type,
  ...(native.type === "model_change" && native.modelId ? { model: native.provider ? `${native.provider}/${native.modelId}` : String(native.modelId) } : {}),
  ...(native.rarebitFork ? { rarebitFork: { version: native.rarebitFork.version, kind: native.rarebitFork.kind } } : {}),
  ...(native.type === "custom" ? { customType: native.customType, data: { schemaVersion: native.data?.schemaVersion,
   opening: { seedEntryId: native.data?.opening?.seedEntryId }, importedEntryIds: native.data?.importedEntryIds } } : {}) };
 return {
  rarebit: { occurrence: occurrence ? { sourceEntryId: occurrence.sourceEntryId, outcome: occurrence.outcome, timestamp: occurrence.timestamp, text: occurrence.text.slice(0, 700) } : null,
   item, totalMessageProseChars: measurement.totalMessageProseChars, rarebitChars: measurement.rarebitChars },
  proseCounts: chars, lineage,
 };
}

/** Visits a Pi range as ReaderItems with the semantics the ingestion worker derives from. */
export function visitIngestItems(reader: PiRange, visit: (item: ReaderItem<IngestSemantics>) => void, options: { after?: string | null } = {}) {
 reader.visit((row) => visit({ entry: row.entry, position: row.position, semantics: ingest(row), ...(row.source?.data !== undefined ? { data: row.source.data } : {}) }), options);
}

/** Visits a Pi range as ReaderItems with the text in-Session Find matches. */
export function visitFindItems(reader: PiRange, visit: (item: ReaderItem<FindSemantics>) => void) {
 reader.visit((row) => visit({ entry: row.entry, position: row.position, semantics: { findText: mirrorEntryText(row.native) } }));
}

/** The published selector decides occurrence semantics; this probe supplies its version. */
export const rarebitSelectorVersion = () => String(selectRarebits([]).manifest.selectorVersion);

/** A Pi fork copies its parent's entries; those written before the fork's header are inherited. NaN when not a fork. */
/** A durable copy names the bound itself (durable-copy.mjs session().inheritedBefore). */
export function inheritedBefore(session: { header?: { parentSession?: string; timestamp?: string } | null; inheritedBefore?: number }): number {
 if (typeof session.inheritedBefore === "number") return session.inheritedBefore;
 return session.header?.parentSession ? Date.parse(session.header.timestamp ?? "") - 1000 : NaN;
}
