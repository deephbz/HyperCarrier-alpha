import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const store = new Map<string, string>();
Object.assign(globalThis, {
	localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});
const { ARC_PANEL_MIN_PANE, ARC_REOPEN_KEY, PANEL_DEFAULT_KEY, migrateArcPreference, panelClosed, panelOnSessionOpen, rememberArcShown } = await import("../web/src/views/cos/arc-reopen.ts");

test("the panel ✕ on Arc stops a wide Session from reopening Arc (R20)", () => {
	rememberArcShown(true);
	assert.equal(store.get(ARC_REOPEN_KEY), "1");
	panelClosed("rarebit");
	assert.equal(store.get(ARC_REOPEN_KEY), "1");
	panelClosed("arc");
	assert.equal(store.get(ARC_REOPEN_KEY), "0");
});

test("a Session open reopens Arc only on a wide pane after an explicit show, and collapses a saved Arc on a narrow pane (R16)", () => {
	const wide = ARC_PANEL_MIN_PANE, narrow = ARC_PANEL_MIN_PANE - 1;
	rememberArcShown(true);
	assert.equal(panelOnSessionOpen(undefined, wide), "arc");
	assert.equal(panelOnSessionOpen(undefined, narrow), undefined);
	assert.equal(panelOnSessionOpen("arc", narrow), undefined);
	// Another open panel stays: reopen only fills an empty panel slot, and the width rule only collapses Arc.
	assert.equal(panelOnSessionOpen("timeline", wide), "timeline");
	assert.equal(panelOnSessionOpen("timeline", narrow), "timeline");
	rememberArcShown(false);
	assert.equal(panelOnSessionOpen(undefined, wide), undefined);
	assert.equal(panelOnSessionOpen("arc", wide), "arc");
});

test("the former Arc preferences move to the reopen key once, and never override a recorded choice", () => {
	store.clear();
	store.set("ampi.arc.panel", "open");
	migrateArcPreference();
	assert.deepEqual([store.get(ARC_REOPEN_KEY), store.has("ampi.arc.panel")], ["1", false]);
	store.clear();
	store.set(PANEL_DEFAULT_KEY, "arc");
	migrateArcPreference();
	assert.equal(store.get(ARC_REOPEN_KEY), "1");
	store.clear();
	rememberArcShown(false);
	store.set("ampi.arc.panel", "open");
	migrateArcPreference();
	assert.deepEqual([store.get(ARC_REOPEN_KEY), store.has("ampi.arc.panel")], ["0", false]);
	store.clear();
	migrateArcPreference();
	assert.equal(store.get(ARC_REOPEN_KEY), undefined);
});
