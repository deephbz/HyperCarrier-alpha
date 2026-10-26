// Tab placement of durable threads (node-design.md, Tabs and placement). A tab is a label shared by threads; `order`
// is a fractional key that sorts threads inside one tab. Presentation only, never identity (P4).

import { randomBytes } from "node:crypto";
import type { HerdrLayout } from "../shared/protocol.ts";

export type Tab = { id: string; label: string };
export type Placed = { tab: Tab; order: string; createdAt: number; closed: boolean };

export const FIRST_ORDER = "a0";
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function newTab(label: string): Tab {
	return { id: `tab-${randomBytes(4).toString("hex")}`, label };
}

/** A key that sorts after `a` and before `b` (no upper bound when `b` is undefined). Keys never end in "0". */
export function keyBetween(a: string, b: string | undefined): string {
	if (b !== undefined && a >= b) throw new Error(`keyBetween: ${a} is not before ${b}`);
	if (b !== undefined) {
		let n = 0;
		while ((a[n] ?? "0") === b[n]) n++;
		if (n > 0) return b.slice(0, n) + keyBetween(a.slice(n), b.slice(n));
	}
	const low = a ? DIGITS.indexOf(a[0]!) : 0;
	const high = b !== undefined ? DIGITS.indexOf(b[0]!) : DIGITS.length;
	if (high - low > 1) return DIGITS[Math.round((low + high) / 2)]!;
	if (b !== undefined && b.length > 1) return b.slice(0, 1);
	return DIGITS[low]! + keyBetween(a.slice(1), undefined);
}

/** The key directly after `after` among the keys already used in its tab. */
export function orderAfter(after: string, used: Iterable<string>): string {
	let next: string | undefined;
	for (const key of used) if (key > after && (next === undefined || key < next)) next = key;
	return keyBetween(after, next);
}

/**
 * The tab layout of open threads: one workspace per tab, oldest tab first, with one inner tab whose `panes` are the
 * thread IDs in `order`. Closed threads are in no tab.
 */
export function tabLayout(placed: ReadonlyMap<string, Placed>): HerdrLayout {
	const tabs = new Map<string, { tab: Tab; oldest: number; rows: [string, string][] }>();
	for (const [threadId, row] of placed) {
		if (row.closed) continue;
		let group = tabs.get(row.tab.id);
		if (!group) tabs.set(row.tab.id, (group = { tab: row.tab, oldest: row.createdAt, rows: [] }));
		group.oldest = Math.min(group.oldest, row.createdAt);
		group.rows.push([row.order, threadId]);
	}
	return {
		workspaces: [...tabs.values()]
			.sort((a, b) => a.oldest - b.oldest || (a.tab.id < b.tab.id ? -1 : 1))
			.map(({ tab, rows }) => ({
				id: tab.id,
				label: tab.label,
				tabs: [{ id: tab.id, label: tab.label, panes: rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([, id]) => id) }],
			})),
	};
}
