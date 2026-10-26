import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendDraftQuote, EMPTY_DRAFT, restoreIntents } from "../web/src/composer-drafts.ts";

test("quote draft: multiline selection and optional note append in order", () => {
 const first = appendDraftQuote(EMPTY_DRAFT, "One\r\n\r\nTwo", "My note");
 assert.equal(first.text, "> One\n> \n> Two\n\nMy note\n\n");
 assert.equal(appendDraftQuote(first, "Three", "").text, first.text + "> Three\n\n");
 assert.equal(appendDraftQuote({...EMPTY_DRAFT,text:"Existing"},"One", "").text,"Existing\n\n> One\n\n");
 assert.equal(appendDraftQuote(first, "  ", "ignored"),first);
});
test("quote draft: appending preserves images and retry spans", () => {
 const image = {data:"x",mimeType:"image/png",name:"x"};
 const draft = restoreIntents(EMPTY_DRAFT,[{id:"retry",order:1,text:"Keep",images:[image],whenBusy:"followUp"}]);
 const quoted = appendDraftQuote(draft,"Selection", "Note");
 assert.deepEqual(quoted.spans,draft.spans);
 assert.deepEqual(quoted.images,[image]);
 assert.equal(draft.text,"Keep");
});
