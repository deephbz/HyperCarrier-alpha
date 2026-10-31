import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// One construction path for every overlay (owner incidents B1/B2): Popover.tsx places each menu, card, outline and pill
// in a body portal, and Modal (Dialogs.tsx) renders each dialog there. A component that portals, writes a fixed
// `left` or `top`, or styles its own fixed box would bring back per-overlay placement in a region's zoom and scroller.
const src = fileURLToPath(new URL("../web/src", import.meta.url));
const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => join(src, f));
const where = (pattern: RegExp) => files.flatMap((file) => readFileSync(file, "utf8").split("\n").flatMap((line, i) => (pattern.test(line) ? [`${relative(src, file)}:${i + 1}`] : [])));
const only = (found: string[], owners: string[]) => found.filter((at) => !owners.some((owner) => at.startsWith(`${owner}:`)));

test("only Popover and Modal render in a portal", () => {
	assert.deepEqual(only(where(/createPortal\(/), ["components/Popover.tsx", "components/Dialogs.tsx"]), []);
});

// JSX `style={{ left }}` stays legal: marks and graph nodes sit in flow inside their own relative box.
test("only Popover moves an element by writing its left or top", () => {
	assert.deepEqual(only(where(/\.style\.(left|top)\s*=/), ["components/Popover.tsx"]), []);
});

test("a fixed box in a component is an off-screen measuring copy, and the stylesheet fixes only the layers", () => {
	// Composer measures its draft and QuoteSelection reads the selection's rendered text; both copies are invisible.
	assert.deepEqual(only(where(/position:\s*"?fixed/), ["components/Composer.tsx", "components/QuoteSelection.tsx"]), []);
	const css = readFileSync(join(src, "styles.css"), "utf8");
	const fixed = [...css.matchAll(/([^{}]+)\{[^}]*position:\s*fixed/g)].map((m) => m[1]!.trim().split("\n").at(-1)!.trim());
	assert.deepEqual(fixed, [".popover", ".modal-back", ".toast"]);
});

// Popover narrows each popover to the room the viewport leaves beside its anchor. A member that sizes its own width
// against the viewport guesses that room: `calc(100vw - 300px)` assumed a sidebar and left a 90 px card at 390 px.
test("a popover's stylesheet width is its natural width; only Popover fits it to the viewport", () => {
	const members = new Set(files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/<Popover\b[^>]*?className="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/))));
	assert.ok(members.has("session-metadata") && members.has("prompt-outline"), `Popover members: ${[...members].join(", ")}`);
	const css = [src, join(src, "views")].flatMap((dir) => (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(dir, f), "utf8")));
	const guessed = css.flatMap((sheet) => [...sheet.matchAll(/([^{}]+)\{([^}]*)\}/g)].flatMap(([, selector, body]) => {
		const classes = [...selector!.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
		if (!classes.some((c) => members.has(c))) return [];
		const widths = body!.split(";").map((d) => d.trim()).filter((d) => /^((min-|max-)?width|inline-size)\s*:/.test(d) && /\d(vw|vi|vmin|vmax)\b/.test(d));
		return widths.map((d) => `${selector!.trim().split("\n").at(-1)!.trim()} { ${d} }`);
	}));
	assert.deepEqual(guessed, []);
});

// Content that slides or scrolls under a still pointer fires enter and over events. A trigger on them opens a card or
// moves a list's selection without the reader moving the pointer; hoverIntent (Popover.tsx) is the one hover trigger.
test("only hoverIntent turns a pointer into hover", () => {
	const found = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\bon(?:Mouse|Pointer)(?:Enter|Over)\b|["'](?:mouse|pointer)(?:enter|over)["']/g)]
		.map((m) => `${relative(src, file)}: ${m[0]}`));
	assert.deepEqual(found, []);
});

// A component module has no import-time side effect: a server render or a test that stubs `window` imports it.
test("a component installs no window or document listener at import", () => {
	const found = files.filter((file) => file.includes("/components/")).flatMap((file) =>
		[...readFileSync(file, "utf8").matchAll(/^(?:if \(.*\)\s*)?(?:window|document)\.addEventListener\b.*$/gm)].map((m) => `${relative(src, file)}: ${m[0]}`));
	assert.deepEqual(found, []);
});

// An action menu (the t-more-menu style, or role "menu") takes the keyboard through Popover's `menu`: its portal
// follows the page's other controls, so without it Tab skips the open menu.
test("every action menu takes the keyboard through Popover's menu", () => {
	const popovers = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/<Popover\b.*$/gm)].map((m) => ({ at: relative(src, file), tag: m[0] })));
	const menus = popovers.filter(({ tag }) => /className="[^"]*\bt-more-menu\b|role="menu"/.test(tag));
	assert.ok(menus.length >= 2, `action menus: ${menus.map((m) => m.at).join(", ")}`);
	assert.deepEqual(menus.filter(({ tag }) => !/\smenu[\s>]/.test(tag)).map((m) => m.at), []);
});
