import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { COMPOSER_BUSY_HINT, COMPOSER_SHORTCUTS, composerSubmission } from "../web/src/composer-keys.ts";

function source(name: string) {
	return ts.createSourceFile(name, readFileSync(new URL(`../web/src/components/${name}.tsx`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
	assert.match(dialogSource, /KEYMAP\.filter\(\(binding\) => binding\.region === region\)/);
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
