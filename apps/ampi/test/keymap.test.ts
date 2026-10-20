import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dispatchGlobalKey, KEYMAP, keyAvailable, registerKeyAction, regionToggle, registerOverlay } from "../web/src/keymap.ts";

test("global bindings have unique physical keys per modifier set and scope", () => {
	const seen = new Set<string>();
	for (const binding of KEYMAP) {
		if (!binding.code) continue;
		const signature = [binding.region, binding.code, binding.meta, binding.ctrl, binding.alt, binding.shift].join(":");
		assert.ok(!seen.has(signature), `duplicate binding ${signature}`);
		seen.add(signature);
	}
});

test("focus toggle distinguishes hidden, visible-unfocused, and focused regions", () => {
	assert.equal(regionToggle(true, false), "show-and-focus");
	assert.equal(regionToggle(false, false), "focus");
	assert.equal(regionToggle(false, true), "hide-and-return");
});

test("the Arc button uses the ArcPanel toggle; Cmd+L opens the configured default panel (focus R15)", () => {
	const root = new URL("../web/src/", import.meta.url);
	// The Session header's Arc button sits in the Rarebit controls.
	const controls = readFileSync(new URL("views/rarebit/Lens.tsx", root), "utf8");
	const app = readFileSync(new URL("App.tsx", root), "utf8");
	assert.match(controls, /onClick=\{\(\) => toggleArcPanel\(panel, setPanel\)\}>Arc</);
	assert.match(app, /localStorage\.getItem\(PANEL_DEFAULT_KEY\)/);
});

test("Cmd+L hide is an explicit close: hiding Arc stops a wide Session from reopening it (focus R21)", () => {
	const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
	assert.match(app, /panel: \(open\) => \{\s*if \(!open && panel\) panelClosed\(panel\);/);
});

test("a global binding without a handler is unavailable: it does not fire, the palette omits it, help names its context", () => {
	const shell = KEYMAP.find((binding) => binding.id === "shell")!;
	const key = () => {
		const event = { code: "KeyJ", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, target: null, preventDefault() { event.defaultPrevented = true; } };
		dispatchGlobalKey(event as unknown as KeyboardEvent);
		return event.defaultPrevented;
	};
	assert.equal(keyAvailable(shell), false);
	assert.equal(key(), false);
	let fired = 0;
	const unregister = registerKeyAction("shell", () => { fired += 1; });
	assert.equal(keyAvailable(shell), true);
	assert.equal(key(), true);
	assert.equal(fired, 1);
	unregister();
	assert.equal(keyAvailable(shell), false);
	assert.equal(keyAvailable(KEYMAP.find((binding) => binding.region === "transcript")!), true);
});

test("an open overlay gates global chords in the dispatcher: its own chord and palette switching pass (focus R12)", () => {
	const fired: string[] = [];
	const off = [registerKeyAction("sidebar.toggle", () => fired.push("sidebar")), registerKeyAction("session.palette", () => fired.push("palette")), registerKeyAction("command.palette", () => fired.push("commands"))];
	const press = (code: string, shift = false) => {
		const event = { code, metaKey: true, ctrlKey: false, shiftKey: shift, altKey: false, defaultPrevented: false, target: null, preventDefault() { event.defaultPrevented = true; } };
		dispatchGlobalKey(event as unknown as KeyboardEvent);
	};
	let release = () => {};
	try {
		release = registerOverlay("palette");
		press("KeyB");
		press("KeyK");
		press("KeyK", true);
		release();
		press("KeyB");
		assert.deepEqual(fired, ["palette", "commands", "sidebar"]);
	} finally {
		release();
		for (const done of off) done();
	}
});
