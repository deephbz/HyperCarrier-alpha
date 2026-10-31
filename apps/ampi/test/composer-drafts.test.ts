import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Custody, type Draft, type Outcome, type SendIntent, MAYBE_SENT, appendDraftText, carriedDraft, editDraft, giveBack, noticeKeyed, outcomeText, prependDraftText, restoreReturned, takeDraft } from "../web/src/composer-drafts.ts";

type Img = { name: string };
const LOST: Outcome = { uncertain: true, text: "devbox did not answer." };
const REFUSED: Outcome = { uncertain: false, text: "Not sent: refused." };
const UNKNOWN_EDIT: Outcome = { uncertain: true, text: "Edit outcome unknown" };
const image = { name: "sample.png" };
/** Synthetic keys "n1", "n2", … in call order. */
const keys = () => { let n = 0; return () => `n${++n}`; };
const intent: SendIntent = { whenBusy: "followUp", route: { kind: "message", content: "Retry me" } };
/** A submission with an unknown outcome: it carries its key and the request that went out. */
const uncertain = (text: string, images: Img[] = [], key = "k1"): Draft<Img> => ({ text, images, key, intent });
const empty = (key = "k0"): Custody<Img> => ({ draft: { text: "", images: [], key }, returned: [] });
const admitAll = (_current: readonly Img[], incoming: readonly Img[]) => ({ accepted: [...incoming], rejected: [] });

test("a late outcome never writes over a newer draft", () => {
	const typed: Custody<Img> = { ...empty(), draft: { text: "Newer", images: [image], key: "k2" } };
	const back = giveBack(typed, uncertain("Older"), { id: "r1", outcome: LOST, newKey: keys() });
	assert.deepEqual(back.draft, typed.draft);
	assert.deepEqual(back.returned.map((r) => [r.text, r.key, r.intent]), [["Older", "k1", intent]], "the held record keeps its retry identity");
});

test("one draft yields at most one submission", () => {
	const [after, first] = takeDraft({ ...empty("k1"), draft: { text: "Once", images: [], key: "k1" } }, "k2");
	assert.equal(first.text, "Once");
	const [, second] = takeDraft(after, "k3");
	assert.deepEqual([second.text, second.images, second.key], ["", [], "k2"], "a second take finds an empty draft under the new key");
});

test("restore keeps the key and intent only into an empty draft with all images", () => {
	const held: Custody<Img> = { ...empty(), returned: [{ ...uncertain("Retry me", [image]), id: "r1", outcome: LOST }] };
	const whole = restoreReturned(held, "r1", admitAll, keys());
	assert.deepEqual(whole.draft, uncertain("Retry me", [image]), "the same request retries under the same key");
	const partial = restoreReturned(held, "r1", (_c, incoming) => ({ accepted: [], rejected: [...incoming] }), keys());
	assert.equal(partial.draft.key, "n1");
	assert.equal(partial.draft.intent, undefined, "a draft without all images is a new message");
	const busy = restoreReturned({ ...held, draft: { text: "Typed", images: [], key: "k5" } }, "r1", admitAll, keys());
	assert.deepEqual([busy.draft.text, busy.draft.key, busy.draft.intent], ["Retry me\n\nTyped", "n1", undefined], "a merge is a new payload");
});

test("the first payload edit rekeys and drops the intent; later edits keep the new key", () => {
	const custody: Custody<Img> = { ...empty(), draft: uncertain("Retry me") };
	const newKey = keys();
	const once = editDraft(custody, { text: "Retry me!" }, newKey);
	assert.deepEqual([once.draft.key, once.draft.intent], ["n1", undefined]);
	assert.equal(editDraft(once, { text: "Retry me!!" }, newKey).draft.key, "n1");
	assert.equal(editDraft(custody, { images: [image] }, keys()).draft.key, "n1", "an image change is a payload change");
	assert.equal(editDraft(custody, { text: "Retry me" }, keys()), custody, "no change keeps the identity");
	const plain: Custody<Img> = { ...empty(), draft: { text: "A", images: [], key: "k4" } };
	assert.equal(editDraft(plain, { images: [image] }, keys()).draft.key, "k4", "a draft without a retry identity keeps its key");
});

test("returned queue text and kept edits rekey an uncertain draft", () => {
	const custody: Custody<Img> = { ...empty(), draft: uncertain("Retry me") };
	const prepended = prependDraftText(custody, "Returned", keys());
	assert.deepEqual([prepended.draft.text, prepended.draft.key, prepended.draft.intent], ["Returned\n\nRetry me", "n1", undefined]);
	const appended = appendDraftText(custody, "Edited", keys(), UNKNOWN_EDIT);
	assert.deepEqual([appended.draft.text, appended.draft.key], ["Retry me\n\nEdited", "n1"]);
	assert.deepEqual(appended.notices?.map((n) => [n.text, n.outcome]), [["Edited", UNKNOWN_EDIT]]);
	assert.deepEqual(editDraft(appended, { text: "Retry me" }, keys()).notices?.map((n) => n.outcome), [UNKNOWN_EDIT], "an uncertain notice outlasts its text");
	const refused = appendDraftText(custody, "Edited", keys(), REFUSED);
	assert.deepEqual(editDraft(refused, { text: "Retry me" }, keys()).notices, [], "a refusal notice ends when its text leaves the draft");
});

test("a final refusal gives the submission back under a fresh key", () => {
	const back = giveBack(empty(), uncertain("Refused", [image]), { id: "r1", outcome: REFUSED, newKey: keys() });
	assert.deepEqual(back.draft, { text: "Refused", images: [image], key: "n1" });
});

test("a fork carries text, images, and notices under a new key, never returned records, and leaves the source", () => {
	const source: Custody<Img> = appendDraftText({ draft: uncertain("Mine", [image]), returned: [{ ...uncertain("Held"), id: "r1", outcome: LOST }] }, "An edit", keys(), UNKNOWN_EDIT);
	const before = structuredClone(source);
	const carried = carriedDraft(source, undefined, () => "fork")!;
	assert.deepEqual(carried.draft, { text: source.draft.text, images: [image], key: "fork" }, "the fork never retries the source's sends");
	assert.deepEqual(carried.returned, []);
	assert.deepEqual(carried.notices?.map((n) => n.outcome), [UNKNOWN_EDIT]);
	assert.deepEqual(source, before, "the source is unchanged");
	assert.equal(carriedDraft(source, { ...empty(), draft: { text: "Fork's own", images: [], key: "f" } }, keys()), undefined, "a draft already on the fork wins");
	assert.equal(carriedDraft(source, { ...empty(), returned: [{ ...uncertain("x"), id: "r", outcome: LOST }] }, keys()), undefined);
	assert.equal(carriedDraft(undefined, undefined, keys()), undefined);
});

test("a fork warns about a draft whose send to the source has an unknown outcome", () => {
	const carried = carriedDraft<Img>({ draft: uncertain("Maybe sent", [image]), returned: [] }, undefined, () => "fork")!;
	assert.deepEqual(carried.draft, { text: "Maybe sent", images: [image], key: "fork" }, "the intent stays with the source");
	assert.deepEqual(carried.notices?.map((n) => [n.text, n.outcome]), [["Maybe sent", { uncertain: true, text: MAYBE_SENT }]]);
	assert.equal(editDraft(carried, { text: "Other" }, keys()).notices?.length, 1, "the warning outlasts its text");
});

test("a fork states a carried uncertain send once, without its retry promise", () => {
	const lost: Outcome = { uncertain: true, text: "devbox did not answer.", once: "Send again delivers it once." };
	const source = giveBack<Img>(empty(), uncertain("Maybe sent"), { id: "r1", outcome: lost, newKey: keys() });
	assert.equal(outcomeText(lost, noticeKeyed(source.draft, source.notices![0]!)), "devbox did not answer. Send again delivers it once.");
	const carried = carriedDraft(source, undefined, () => "fork")!;
	assert.equal(carried.notices?.length, 1, "one notice, no second fork warning");
	assert.equal(outcomeText(lost, noticeKeyed(carried.draft, carried.notices![0]!)), `devbox did not answer. ${MAYBE_SENT}`);
});
