import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Chromium antialiases a dotted or dashed text decoration of `auto` thickness on some paints and not on others, so the
// same page gives two screenshots (the HUD trigger drifted in preview A/A). A fixed whole-pixel thickness paints one way.
// The rule holds for every stylesheet, so a new dotted decoration cannot bring the drift back.

const src = fileURLToPath(new URL("../web/src", import.meta.url));
const sheets = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".css"));

test("a dotted or dashed text decoration sets a whole-pixel thickness (failure: preview shots of one page differ in its underline)", () => {
	const found: string[] = [];
	for (const sheet of sheets) {
		const css = readFileSync(join(src, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			if (!/text-decoration(-style)?\s*:[^;]*\b(dotted|dashed)\b/.test(body!)) continue;
			found.push(sheet);
			assert.match(body!, /text-decoration-thickness\s*:\s*\d+px\s*(;|$)/, `${sheet}: ${selector!.trim()}`);
		}
	}
	assert.ok(found.length >= 2, `the scan finds the dotted decorations (${found.join(", ")})`);
});
