import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { KEYMAP, regionToggle } from "../web/src/keymap.ts";

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

test("Arc button and Cmd+L use the ArcPanel toggle authority", () => {
	const root = new URL("../web/src/", import.meta.url);
	const arcPanel = readFileSync(new URL("views/cos/ArcPanel.tsx", root), "utf8");
	const app = readFileSync(new URL("App.tsx", root), "utf8");
	assert.match(arcPanel, /const toggle = \(\) => toggleArcPanel\(panel, setPanel\)/);
	assert.match(app, /toggleArcPanel\(panel, setPanel/);
});
