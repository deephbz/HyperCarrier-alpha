import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { overlayChord, transition, type Focus, type KeyIntent, type Region, type SessionRegion, type View } from "../web/src/focus.ts";

const session: View = { session: true, sidebarHidden: false, panelShown: false, modal: false, oneSide: false };
const page: View = { ...session, session: false };
const withPanel: View = { ...session, panelShown: true };
const phone: View = { ...session, sidebarHidden: true, oneSide: true };
const at = (region: Region | null, ...recent: SessionRegion[]): Focus => ({ region, recent: recent.length ? recent : ["transcript"] });

// One row per cell of TABLE.md §3 and RULINGS.md: [name, view, focus, intent, first target or "unavailable", view change, ifLost].
const rows: [string, View, Focus, KeyIntent, string, object?, boolean?][] = [
	["⌘B hidden → show, sidebar", { ...session, sidebarHidden: true }, at("composer", "composer"), "sidebar.toggle", "sidebar", { sidebar: "show" }],
	["⌘B visible from transcript → sidebar", session, at("transcript"), "sidebar.toggle", "sidebar"],
	["⌘B visible from body → sidebar", session, at(null), "sidebar.toggle", "sidebar"],
	["⌘B from sidebar → hide, last composer", session, at("sidebar", "composer"), "sidebar.toggle", "composer", { sidebar: "hide" }],
	["⌘B from sidebar → hide, last transcript", session, at("sidebar", "transcript"), "sidebar.toggle", "transcript", { sidebar: "hide" }],
	["⌘B from sidebar, last panel gone → transcript", session, at("sidebar", "panel"), "sidebar.toggle", "transcript", { sidebar: "hide" }],
	["⌘B from sidebar, last panel shown → panel", withPanel, at("sidebar", "panel"), "sidebar.toggle", "panel", { sidebar: "hide" }],
	["⌘B from sidebar on a page → page root", page, at("sidebar"), "sidebar.toggle", "page", { sidebar: "hide" }],
	["⌘L closed → open default, panel", session, at("composer", "composer"), "panel.toggle", "panel", { panel: "open" }],
	["⌘L open, from composer → panel", withPanel, at("composer", "composer"), "panel.toggle", "panel"],
	["⌘L from panel → close, last composer", withPanel, at("panel", "panel", "composer"), "panel.toggle", "composer", { panel: "close" }],
	["⌘L from panel, last panel → close, transcript", withPanel, at("panel", "panel"), "panel.toggle", "transcript", { panel: "close" }],
	["⌘L on a page → unavailable", page, at("sidebar"), "panel.toggle", "unavailable"],
	["⌘I transcript → composer", session, at("transcript"), "composer.toggle", "composer"],
	["⌘I composer → transcript", session, at("composer", "composer"), "composer.toggle", "transcript"],
	["⌘I sidebar → composer", session, at("sidebar"), "composer.toggle", "composer"],
	["⌘I panel → composer", withPanel, at("panel", "panel"), "composer.toggle", "composer"],
	["⌘I body → composer", session, at(null), "composer.toggle", "composer"],
	["⌘I on a page → unavailable", page, at(null), "composer.toggle", "unavailable"],
	["i in transcript → composer", session, at("transcript"), "insert", "composer"],
	["i in composer → unavailable (types i)", session, at("composer", "composer"), "insert", "unavailable"],
	["Esc on overlaid panel → close, last composer", withPanel, at("panel", "panel", "composer"), "panel.close", "composer", { panel: "close" }],
	["Esc on overlaid panel, last panel → transcript", withPanel, at("panel", "panel"), "panel.close", "transcript", { panel: "close" }],
	["find Esc → last composer", session, at(null, "composer"), "find.close", "composer"],
	["find Esc, last panel gone → transcript", session, at(null, "panel"), "find.close", "transcript"],
	["find match → transcript", session, at(null, "composer"), "find.go", "transcript"],
	["Session open → composer", session, at("sidebar"), "session.switch", "composer"],
	["⌘0 → Overview content (D20)", session, at("transcript"), "overview", "page"],
	["⌘0 from the sidebar → Overview content (D20)", session, at("sidebar"), "overview", "page"],
	["⌘0 with the sidebar hidden → Overview content", { ...session, sidebarHidden: true }, at("transcript"), "overview", "page"],
	["Back to a Session entry left in the transcript → transcript", session, { ...at(null, "composer"), entry: "transcript" }, "history.move", "transcript"],
	["Back to a Session entry left in the composer → composer", session, { ...at(null), entry: "composer" }, "history.move", "composer"],
	["Back to a Session entry left in the panel, panel shown → panel", withPanel, { ...at(null), entry: "panel" }, "history.move", "panel"],
	["Back to a Session entry left in the panel, panel gone → return target", session, { ...at(null, "composer"), entry: "panel" }, "history.move", "composer"],
	["Back to a Session entry left in the sidebar → sidebar", session, { ...at(null), entry: "sidebar" }, "history.move", "sidebar"],
	["Back to a Session entry left in a hidden sidebar → return target", { ...session, sidebarHidden: true }, { ...at(null), entry: "sidebar" }, "history.move", "transcript"],
	["Back to a Session entry with no record → transcript, not the composer default", session, at("composer", "transcript"), "history.move", "transcript"],
	["Forward to the Overview left on its content → page", page, { ...at(null), entry: "page" }, "history.move", "page"],
	["Forward to a page left in the sidebar → sidebar", page, { ...at(null), entry: "sidebar" }, "history.move", "sidebar"],
	["Back to a page with a Session record → page", page, { ...at(null), entry: "transcript" }, "history.move", "page"],
	["panel ✕ or tab → last if lost", withPanel, at(null, "composer"), "panel.set", "composer", {}, true],
	["panel ✕ with focus in panel, last panel → transcript if lost", session, at(null, "panel"), "panel.set", "transcript", {}, true],
	["resize removes focus → last if lost", session, at(null, "composer"), "layout.change", "composer", {}, true],
	["layout change on a page → sidebar if lost", page, at(null), "layout.change", "sidebar", {}, true],
	["layout change on a page, sidebar hidden → page root if lost", { ...page, sidebarHidden: true }, at(null), "layout.change", "page", {}, true],
	["Modal open: ⌘B → unavailable", { ...session, modal: true }, at(null), "sidebar.toggle", "unavailable"],
	["Modal open: ⌘I → unavailable", { ...session, modal: true }, at(null), "composer.toggle", "unavailable"],
	["☰ hidden → show, last if lost", { ...session, sidebarHidden: true }, at(null, "composer"), "sidebar.show", "composer", { sidebar: "show" }, true],
	["☰ on a page → show, sidebar if lost", { ...page, sidebarHidden: true }, at(null), "sidebar.show", "sidebar", { sidebar: "show" }, true],
	["sidebar hide button → hide, last composer", session, at("sidebar", "composer"), "sidebar.hide", "composer", { sidebar: "hide" }],
	["sidebar hide on a page → page root", page, at("sidebar"), "sidebar.hide", "page", { sidebar: "hide" }],
	["sidebar hide with focus in the composer → focus stays", session, at("composer", "composer"), "sidebar.hide", "composer", { sidebar: "hide" }],
	["sidebar hide when hidden → unavailable", { ...session, sidebarHidden: true }, at(null), "sidebar.hide", "unavailable"],
	["desktop: ⌘L with the sidebar shown keeps it", session, at("transcript"), "panel.toggle", "panel", { panel: "open" }],
	["desktop: ☰ with the panel shown keeps it", { ...withPanel, sidebarHidden: true }, at(null, "panel"), "sidebar.show", "panel", { sidebar: "show" }, true],
	["phone: ☰ with the panel shown → show, panel closes, sidebar", { ...phone, panelShown: true }, at(null, "panel"), "sidebar.show", "sidebar", { sidebar: "show", panel: "close" }],
	["phone: ☰ → show, sidebar", phone, at("composer", "composer"), "sidebar.show", "sidebar", { sidebar: "show" }],
	["phone: navigate with the drawer open → hide, last but never the composer", { ...phone, sidebarHidden: false }, at("sidebar", "composer"), "navigate", "transcript", { sidebar: "hide" }],
	["phone: the drawer closes from the sidebar → hide, last but never the composer", { ...phone, sidebarHidden: false }, at("sidebar", "composer", "transcript"), "sidebar.hide", "transcript", { sidebar: "hide" }],
	["phone: the panel closes from the panel → close, last but never the composer", { ...phone, panelShown: true }, at("panel", "panel", "composer"), "panel.close", "transcript", { panel: "close" }],
	["phone: a Session opens → its transcript, so no keyboard rises", { ...phone, sidebarHidden: false }, at("sidebar", "composer"), "session.switch", "transcript"],
	["phone: navigate with the drawer closed → unavailable", phone, at("transcript"), "navigate", "unavailable"],
	["desktop: navigate → unavailable", session, at("sidebar"), "navigate", "unavailable"],
	["phone: ⌘B with the panel shown → show, panel closes", { ...phone, panelShown: true }, at(null), "sidebar.toggle", "sidebar", { sidebar: "show", panel: "close" }],
	["phone: ⌘L with the sidebar shown → sidebar hides", { ...phone, sidebarHidden: false }, at("sidebar"), "panel.toggle", "panel", { panel: "open", sidebar: "hide" }],
	["phone: a writer set the panel with the sidebar shown → sidebar hides", { ...phone, sidebarHidden: false, panelShown: true }, at("sidebar", "composer"), "panel.set", "transcript", { sidebar: "hide" }, true],
];

for (const [name, view, focus, intent, expected, change, ifLost] of rows) {
	test(`focus table: ${name}`, () => {
		const next = transition(view, focus, intent);
		if (expected === "unavailable") return assert.equal(next.kind, "unavailable");
		assert.equal(next.kind, "move");
		if (next.kind !== "move") return;
		assert.equal(next.chain[0], expected);
		assert.deepEqual(next.change, change ?? {});
		assert.equal(Boolean(next.ifLost), Boolean(ifLost));
	});
}

const intents: KeyIntent[] = ["sidebar.toggle", "sidebar.show", "sidebar.hide", "navigate", "panel.toggle", "composer.toggle", "insert", "panel.close", "find.close", "find.go", "session.switch", "overview", "history.move", "panel.set", "layout.change"];
const regions: (Region | null)[] = ["sidebar", "transcript", "composer", "panel", null];
const lasts: SessionRegion[] = ["transcript", "composer", "panel"];
const views: View[] = [];
for (const s of [true, false]) for (const sidebarHidden of [true, false]) for (const panelShown of [true, false]) for (const modal of [true, false]) for (const oneSide of [true, false]) views.push({ session: s, sidebarHidden, panelShown: s && panelShown, modal, oneSide });

test("cell matrix: every move has a chain that ends at the page root and names only shown targets", () => {
	let cells = 0;
	for (const view of views) for (const region of regions) for (const last of lasts) for (const intent of intents) {
		const next = transition(view, { region, recent: [last] }, intent);
		cells++;
		if (next.kind !== "move") continue;
		const label = `${intent} from ${region} (last ${last}) in ${JSON.stringify(view)}`;
		assert.equal(next.chain.at(-1), "page", label);
		const shown = { ...view, sidebarHidden: next.change.sidebar ? next.change.sidebar === "hide" : view.sidebarHidden, panelShown: next.change.panel ? next.change.panel === "open" : view.panelShown };
		// A phone shows one side at a time after every move, whatever the view before it.
		if (view.oneSide) assert(shown.sidebarHidden || !shown.panelShown, `both sides shown on a phone: ${label}`);
		if (intent === "overview") continue;
		for (const target of next.chain) {
			if (target === "sidebar") assert(!shown.sidebarHidden, `hidden sidebar in chain: ${label}`);
			if (target === "panel") assert(shown.panelShown, `closed panel in chain: ${label}`);
			if (!view.session) assert(target === "sidebar" || target === "page", `Session region on a page: ${label}`);
		}
		assert(!(next.recent as string[]).includes("sidebar"), label);
	}
	assert.equal(cells, views.length * regions.length * lasts.length * intents.length);
});

test("history.move: every recorded target in every view resolves to a shown target, never by focus loss only", () => {
	for (const view of views) for (const entry of ["sidebar", "transcript", "composer", "panel", "page", undefined] as const) {
		const next = transition({ ...view, modal: false }, { ...at(null), entry }, "history.move");
		const label = `${entry} in ${JSON.stringify(view)}`;
		assert(next.kind === "move" && !next.ifLost, label);
		const first = next.chain[0];
		if (first === "sidebar") assert(!view.sidebarHidden, label);
		if (first === "panel") assert(view.panelShown, label);
		if (!view.session) assert(first === "sidebar" || first === "page", label);
	}
});

test("an open Modal blocks every key intent; view changes still resolve", () => {
	for (const region of regions) for (const intent of intents) {
		const next = transition({ ...session, modal: true }, at(region), intent);
		const viewChange = intent === "session.switch" || intent === "panel.set" || intent === "layout.change";
		assert.equal(next.kind === "move", viewChange, `${intent} from ${region}`);
	}
});

test("composer, then panel, then close: the panel close returns to the composer (recent list)", () => {
	const opened = transition(session, at("composer", "composer", "transcript"), "panel.toggle");
	assert(opened.kind === "move");
	const closed = transition(withPanel, { region: "panel", recent: opened.recent }, "panel.toggle");
	assert(closed.kind === "move" && closed.chain[0] === "composer");
});

test("the sidebar and page never become the return target", () => {
	for (const intent of ["sidebar.toggle", "overview"] as const) {
		const next = transition(session, at("transcript", "composer"), intent);
		assert(next.kind === "move" && next.recent[0] === "composer");
	}
});

test("an open overlay passes only its own close chord and palette switching", () => {
	assert.equal(overlayChord("palette", "session.palette"), "close");
	assert.equal(overlayChord("palette", "command.palette"), "switch");
	assert.equal(overlayChord("commands", "session.palette"), "switch");
	assert.equal(overlayChord("help", "help"), "close");
	assert.equal(overlayChord("palette", "sidebar.toggle"), "blocked");
	assert.equal(overlayChord("dialog", "session.palette"), "blocked");
});
