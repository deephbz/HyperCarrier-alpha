import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendDraftQuote } from "../web/src/composer-drafts.ts";

test("quote draft: multiline selection and optional note append in order", () => {
	const first = appendDraftQuote({ text: "" }, "One\r\n\r\nTwo", "My note");
	assert.equal(first.text, "> One\n> \n> Two\n\nMy note\n\n");
	assert.equal(appendDraftQuote(first, "Three", "").text, first.text + "> Three\n\n");
	assert.equal(appendDraftQuote({ text: "Existing" }, "One", "").text, "Existing\n\n> One\n\n");
	assert.equal(appendDraftQuote(first, "  ", "ignored"), first);
});
test("quote draft: appending preserves the rest of the draft", () => {
	const image = { data: "x", mimeType: "image/png", name: "x" };
	const draft = { text: "Keep", images: [image], key: "k1" };
	const quoted = appendDraftQuote(draft, "Selection", "Note");
	assert.deepEqual([quoted.images, quoted.key], [[image], "k1"]);
	assert.equal(draft.text, "Keep");
});
