import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_DRAFT, editDraftText, editDraftImages, draftParts, restoreIntents, refuseIntent, prependDraftText, appendDraftText, carriedDraft, type SendIntent } from "../web/src/composer-drafts.ts";

const image = { data: "synthetic", mimeType: "image/png", name: "sample.png" };
const intent = (id: string, order: number, text: string, images = [] as typeof image[]): SendIntent => ({ id, order, text, images, whenBusy: "followUp" });

test("retry spans retain payloads and IDs; an edit invalidates only its span", () => {
	const a = intent("a", 1, "First"), b = intent("b", 2, "Second");
	const draft = restoreIntents({ ...EMPTY_DRAFT, text: "New text" }, [a, b]);
	assert.equal(draft.text, "First\n\nSecond\n\nNew text");
	assert.deepEqual(draftParts(draft).map((p) => [p.text, p.intent?.id]), [["First", "a"], ["Second", "b"], ["New text", undefined]]);
	const edited = editDraftText(draft, "First changed\n\nSecond\n\nNew text");
	assert.deepEqual(draftParts(edited).map((p) => [p.text, p.intent?.id]), [["First changed", undefined], ["Second", "b"], ["New text", undefined]]);
});

test("separate outside regions keep textarea order; separators do not belong to retry spans", () => {
	const draft = restoreIntents(EMPTY_DRAFT, [intent("a", 1, "A"), intent("b", 2, "B")]);
	const edited = editDraftText(editDraftText(draft, "before\n\nA\n\nB"), "before\n\nA\n\nbetween\n\nB");
	assert.deepEqual(draftParts(edited).map((p) => [p.text, p.intent?.id]), [["before", undefined], ["A", "a"], ["between", undefined], ["B", "b"]]);
	for (const text of ["  spaces stay  \n", "\n\npayload\n\n"]) assert.equal(draftParts({ ...EMPTY_DRAFT, text })[0]!.text, text);
});

test("failures restore in original send order before a newer draft, regardless of completion order", () => {
	const a = intent("a", 1, "First"), b = intent("b", 2, "Second");
	for (const order of [[a, b], [b, a]]) {
		let draft = { ...EMPTY_DRAFT, text: "New draft" };
		for (const item of order) draft = restoreIntents(draft, [item]);
		assert.equal(draft.text, "First\n\nSecond\n\nNew draft");
		assert.equal(restoreIntents(draft, [a]).text, draft.text, "one failed intent restores once");
	}
});

test("a final key_conflict drops only the refused identity and preserves every payload", () => {
	const a = intent("a", 1, "First"), b = intent("b", 2, "Second", [image]);
	const draft = refuseIntent(restoreIntents({ ...EMPTY_DRAFT, text: "New draft" }, [a, b]), a.id);
	assert.equal(draft.text, "First\n\nSecond\n\nNew draft");
	assert.deepEqual(draftParts(draft).map((part) => [part.text, part.intent?.id]), [["First", undefined], ["Second", "b"], ["New draft", undefined]]);
	assert.deepEqual(draft.images, [image]);
});

test("returned queue text is plain, even when it equals a retry span", () => {
	const draft = prependDraftText(restoreIntents(EMPTY_DRAFT, [intent("a", 1, "Same")]), "Same");
	assert.deepEqual(draftParts(draft).map((part) => [part.text, part.intent?.id]), [["Same", undefined], ["Same", "a"]]);
});

test("restoration keeps literal payload whitespace and image-only intents", () => {
	const a = intent("a", 1, "\n\n  First  \n\n"), b = intent("b", 2, "", [image]);
	const draft = restoreIntents({ ...EMPTY_DRAFT, text: "\n\nfree\n\n" }, [a, b]);
	assert.deepEqual(draftParts(draft).map((p) => [p.text, p.intent?.id]), [[a.text, "a"], ["", "b"], ["\n\nfree\n\n", undefined]]);
	assert.deepEqual(draftParts(draft).map((p) => p.images), [[], [image], []]);
});

test("image changes invalidate only image-bearing spans and keep other retry identities", () => {
	const a = intent("a", 1, "Picture", [image]), b = intent("b", 2, "Text");
	const draft = restoreIntents(EMPTY_DRAFT, [a, b]);
	assert.deepEqual(draftParts(draft).map((p) => p.images), [[image], []]);
	assert.deepEqual(draftParts(editDraftImages(draft, [])).map((p) => [p.text, p.intent?.id]), [["Picture", undefined], ["Text", "b"]]);
});

test("a fork carries the draft's text and its delivery warning, drops retry spans, leaves the source, and keeps its own draft", () => {
	const warning = "Edit outcome unknown: your edited text is at the end of the composer; it may already have been sent.";
	const source = appendDraftText(restoreIntents({ ...EMPTY_DRAFT, text: "Mine" }, [intent("a", 1, "Retry me")]), "A edit", warning);
	const before = structuredClone(source);
	const carried = carriedDraft(source, undefined)!;
	assert.equal(carried.text, source.text);
	assert.deepEqual(carried.spans, [], "the fork never retries the source's sends");
	assert.deepEqual(carried.notices?.map((notice) => [notice.text, notice.message]), [["A edit", warning]]);
	assert.deepEqual(source, before, "the source draft is unchanged");
	assert.equal(carriedDraft(source, { ...EMPTY_DRAFT, text: "Fork's own" }), undefined, "a draft already on the fork wins");
	assert.equal(carriedDraft(undefined, undefined), undefined);
});
