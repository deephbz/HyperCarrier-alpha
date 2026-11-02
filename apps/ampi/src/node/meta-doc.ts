// The node's Session metadata document: thread presentation and placement. A leaf module, so the guard and the
// store files read the one definition without loading the runtime.

import { defineDoc } from "@earendil-works/pi-durable";
import type { ThreadSummary } from "../shared/protocol.ts";
import type { Tab } from "./tabs.ts";

/** Session-scoped AmPi metadata: thread presentation and per-conversation migrations, never identity (P4). */
export type MetaState = {
	createdAt: number;
	root?: string;
	/** This storage's ID, so tools running inside it can find their own store. */
	store?: string;
	convs: Record<string, ConvMeta>;
};
/**
 * One conversation's AmPi metadata. `tab` and `order` place it (node-design.md, Tabs); stores written before tabs
 * have none and show unplaced. `closed` is the stored Close intent: the thread is read-only from then on. Its
 * `attention` keeps the reasons of the runs that were parked at Close, because Close removes their tasks.
 */
export type ConvMeta = {
	kind: ThreadSummary["kind"];
	createdAt: number;
	title?: string;
	archived?: boolean;
	/** Summary retirement committed; later boots skip the legacy document scan. */
	rarebitSummaryRetired?: true;
	tab?: Tab;
	order?: string;
	closed?: { at: number; by: string; attention?: string[] };
};
export const MetaDoc = defineDoc<MetaState>({
	kind: "ampi.meta",
	version: 1,
	checkpointWhen: () => false,
	scope: "session",
	initial: () => ({ createdAt: Date.now(), convs: {} }),
});
