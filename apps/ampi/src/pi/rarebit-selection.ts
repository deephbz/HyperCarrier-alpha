// AmPi's tier-b projection owns owner provenance and exceptional entries. Arc consumes it unchanged.
import { selectRarebits } from "@hypercarrier/rarebit/core";
import type { PiReaderEntry } from "./views/types.ts";
import type { RarebitItem } from "./views/rarebit.ts";
export const OWNER_SELECTOR_VERSION = "owner-1";
export const INJECTED_USER_MESSAGES: RegExp[] = [
 /^# Rarebit Recall\s*$/, /^# (Message|Markdown) Annotations\s*$/, /^New intercom message above\.?\s*$/,
 /^I have \d+ new messages?(\(s\))? in my inbox\b/, /^Restart recovery: call read_inbox\b/, /^ptb\.[a-z][\w-]*:\s/,
];
export function isOwnerTurn(item: Pick<RarebitItem, "kind" | "text">): boolean {
 if (item.kind !== "user") return false;
 const head = item.text.trimStart(), close = head.slice(0, 200).indexOf("]");
 if (INJECTED_USER_MESSAGES.some(re => re.test(head.split("\n", 1)[0]!.trim()))) return false;
 return !(head.startsWith("[") && close > 0) || head.slice(0, close).toLowerCase().includes("owner");
}
export function selectTierB(native: any, e: PiReaderEntry) {
 const selection = selectRarebits([native]);
 if (selection.occurrences[0]?.outcome === "user" && e.kind !== "human") selection.occurrences = [];
 const chosen = selection.occurrences[0];
 let item: RarebitItem | null = chosen?.sourceEntryId ? { id: chosen.sourceEntryId, kind: chosen.outcome, t: chosen.timestamp, text: chosen.text, owner: false } as RarebitItem : null;
 if (e.kind === "compaction") item = { id: e.id, kind: "compaction", t: native.timestamp ?? null, text: "Context restarts here", owner: false };
 if (e.role === "assistant" && e.stop === "error") item = { id: e.id, kind: "error", t: native.timestamp ?? null, text: e.error || "The agent reported a terminal error.", owner: false };
 if (item) item.owner = isOwnerTurn(item);
 // Relays and sendUserMessage injections stay in the transcript, outside tier b.
 if (item?.kind === "user" && !item.owner) item = null;
 return { selection, item };
}
