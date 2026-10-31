import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { COMPOSER_BUSY_HINT, COMPOSER_SHORTCUTS, composerSubmission, freshPress } from "../web/src/composer-keys.ts";

function source(name: string, dir = "components") {
	return ts.createSourceFile(name, readFileSync(new URL(`../web/src/${dir}/${name}.tsx`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
	if (predicate(node)) return node;
	return ts.forEachChild(node, (child) => find(child, predicate));
}
// Run the shipped JSX expressions. This catches a component that bypasses the
// shared key contract, without mounting unrelated hub and model controls.
function evaluate(expression: ts.Node, bindings: Record<string, unknown>) {
	const code = ts.transpileModule(`const value = ${expression.getText()};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	return new Function(...Object.keys(bindings), `${code}\nreturn value;`)(...Object.values(bindings));
}

test("composer help and busy hint match submission keys; newline and IME input never submit", () => {
	const composer = source("Composer"), dialogs = source("Dialogs");
	const textarea = find(composer, (n) => ts.isJsxSelfClosingElement(n) && n.tagName.getText() === "textarea") as ts.JsxSelfClosingElement;
	assert.ok(textarea, "composer textarea exists");
	const attribute = (name: string) => {
		const attr = textarea.attributes.properties.find((n) => ts.isJsxAttribute(n) && n.name.getText() === name) as ts.JsxAttribute;
		return (attr.initializer as ts.JsxExpression).expression!;
	};
	const dialogSource = readFileSync(new URL("../web/src/components/Dialogs.tsx", import.meta.url), "utf8");
	assert.match(dialogSource, /KEYMAP\.filter\(\(binding\) => binding\.region === region && \(keyAvailable\(binding\) \|\| binding\.context\)\)/);
	assert.match(dialogSource, /COMPOSER_KEYS\.map\(/);
	assert.deepEqual(COMPOSER_SHORTCUTS.filter(([key]) => key.includes("Enter")), [
		["Enter", "Send, or steer while the agent works"], ["Alt+Enter", "Queue a follow-up"], ["Shift+Enter", "New line"],
	]);
	assert.equal(evaluate(attribute("placeholder"), { busy: true, COMPOSER_BUSY_HINT }), "Steer now (Enter) or queue a follow-up (Alt+Enter). Esc interrupts.");
	for (const [modifiers, expected] of [
		[{}, "steer"], [{ altKey: true }, "followUp"], [{ shiftKey: true }, null],
		[{ altKey: true, shiftKey: true }, null], [{ isComposing: true }, null],
		[{ ctrlKey: true }, "steer"], [{ metaKey: true }, "steer"],
	] as const) {
		const sent: string[] = []; let prevented = false;
		const handler = evaluate(attribute("onKeyDown"), { composerSubmission, matches: [], send: (mode: string) => sent.push(mode) });
		handler({ key: "Enter", altKey: false, shiftKey: false, ...modifiers, nativeEvent: { isComposing: "isComposing" in modifiers }, preventDefault: () => { prevented = true; } });
		assert.deepEqual(sent, expected ? [expected] : [], JSON.stringify(modifiers));
		assert.equal(prevented, expected !== null, JSON.stringify(modifiers));
	}
});

// A held key auto-repeats into whichever field focus reaches: Restore, a quote, or a palette command moves focus on
// keydown and hands the rest of its press to that field (adversarial-restore holds Enter on Restore). Every field
// that sends on a key sends on the fresh press and never on a repeat.
test("every field that sends on a key sends only on a fresh press", () => {
	const keyDown = (file: ts.SourceFile, label?: string) => {
		const field = find(file, (n) => ts.isJsxSelfClosingElement(n) && n.tagName.getText() === "textarea" && (!label || n.attributes.getText().includes(`aria-label="${label}"`))) as ts.JsxSelfClosingElement;
		assert.ok(field, `${file.fileName} has the field`);
		const attr = field.attributes.properties.find((n) => ts.isJsxAttribute(n) && n.name.getText() === "onKeyDown") as ts.JsxAttribute;
		return (attr.initializer as ts.JsxExpression).expression!;
	};
	const fields = [
		{ name: "Composer", handler: keyDown(source("Composer")), call: "send", chord: {} },
		{ name: "new Session (Dialogs)", handler: keyDown(source("Dialogs"), "First message"), call: "create", chord: { metaKey: true } },
		{ name: "new Pi agent (PiDialogs)", handler: keyDown(source("PiDialogs"), "First message"), call: "create", chord: { ctrlKey: true } },
		{ name: "Rarebit ask", handler: keyDown(source("View", "views/rarebit")), call: "ask", chord: {} },
	];
	for (const { name, handler, call, chord } of fields) for (const repeat of [false, true]) {
		const calls: unknown[] = []; let prevented = false;
		const run = evaluate(handler, { composerSubmission, freshPress, matches: [], [call]: (...args: unknown[]) => calls.push(args) });
		run({ key: "Enter", altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, ...chord, repeat, nativeEvent: { repeat, isComposing: false }, preventDefault: () => { prevented = true; } });
		assert.equal(calls.length, repeat ? 0 : 1, `${name}: ${repeat ? "a repeat sends" : "a fresh press does not send"}`);
		if (name === "Composer" || name === "Rarebit ask") assert.equal(prevented, true, `${name}: a held Enter adds a new line`);
	}
});
