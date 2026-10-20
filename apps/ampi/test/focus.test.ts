import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { overlayChord, transition, type Focus, type KeyIntent, type Region, type SessionRegion, type View } from "../web/src/focus.ts";

const session: View = { session: true, sidebarHidden: false, panelShown: false, modal: false };
const page: View = { ...session, session: false };
const withPanel: View = { ...session, panelShown: true };
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
	["Session switch → composer if lost", session, at("sidebar"), "session.switch", "composer", {}, true],
	["⌘0 → sidebar if lost", session, at("transcript"), "overview", "sidebar", {}, true],
	["⌘0 with the sidebar hidden → page root if lost", { ...session, sidebarHidden: true }, at("transcript"), "overview", "page", {}, true],
	["panel ✕ or tab → last if lost", withPanel, at(null, "composer"), "panel.set", "composer", {}, true],
	["panel ✕ with focus in panel, last panel → transcript if lost", session, at(null, "panel"), "panel.set", "transcript", {}, true],
	["resize removes focus → last if lost", session, at(null, "composer"), "layout.change", "composer", {}, true],
	["layout change on a page → sidebar if lost", page, at(null), "layout.change", "sidebar", {}, true],
	["layout change on a page, sidebar hidden → page root if lost", { ...page, sidebarHidden: true }, at(null), "layout.change", "page", {}, true],
	["Modal open: ⌘B → unavailable", { ...session, modal: true }, at(null), "sidebar.toggle", "unavailable"],
	["Modal open: ⌘I → unavailable", { ...session, modal: true }, at(null), "composer.toggle", "unavailable"],
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

const intents: KeyIntent[] = ["sidebar.toggle", "panel.toggle", "composer.toggle", "insert", "panel.close", "find.close", "find.go", "session.switch", "overview", "panel.set", "layout.change"];
const regions: (Region | null)[] = ["sidebar", "transcript", "composer", "panel", null];
const lasts: SessionRegion[] = ["transcript", "composer", "panel"];
const views: View[] = [];
for (const s of [true, false]) for (const sidebarHidden of [true, false]) for (const panelShown of [true, false]) for (const modal of [true, false]) views.push({ session: s, sidebarHidden, panelShown: s && panelShown, modal });

test("cell matrix: every move has a chain that ends at the page root and names only shown targets", () => {
	let cells = 0;
	for (const view of views) for (const region of regions) for (const last of lasts) for (const intent of intents) {
		const next = transition(view, { region, recent: [last] }, intent);
		cells++;
		if (next.kind !== "move") continue;
		const label = `${intent} from ${region} (last ${last}) in ${JSON.stringify(view)}`;
		assert.equal(next.chain.at(-1), "page", label);
		const shown = { ...view, sidebarHidden: next.change.sidebar ? next.change.sidebar === "hide" : view.sidebarHidden, panelShown: next.change.panel ? next.change.panel === "open" : view.panelShown };
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
