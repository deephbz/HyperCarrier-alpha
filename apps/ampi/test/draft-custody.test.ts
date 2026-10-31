import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Custody, type Outcome, MAYBE_SENT, editDraft, giveBack, isEmpty, noticeKeyed, outcomeText, restoreReturned, takeDraft } from "../web/src/composer-drafts.ts";

type Img = { name: string };
const LOST: Outcome = { uncertain: true, text: "devbox did not answer." };
const REFUSED: Outcome = { uncertain: false, text: "Not sent: refused." };
const start = (text: string, images: Img[] = [], key = "k1"): Custody<Img> => ({ draft: { text, images, key }, returned: [] });
/** Synthetic keys "n1", "n2", … in call order. */
const keys = () => { let n = 0; return () => `n${++n}`; };

// The invariant: a submission holds its own content until its outcome; a late outcome never writes over a newer draft.
test("a late rejection keeps the newer draft and holds the returned message beside it", () => {
	const [sent, first] = takeDraft(start("First message", [{ name: "first.png" }]), "k2");
	assert.deepEqual(first, { text: "First message", images: [{ name: "first.png" }], key: "k1" });
	assert.ok(isEmpty(sent.draft) && sent.draft.key === "k2", "a send leaves an empty draft under a new key");
	const typed: Custody<Img> = { ...sent, draft: { ...sent.draft, text: "Next draft", images: [{ name: "next.png" }] } };
	const back = giveBack(typed, first, { id: "r1", outcome: LOST, newKey: keys() });
	assert.deepEqual(back.draft, typed.draft, "the newer draft is untouched");
	assert.deepEqual(back.returned, [{ id: "r1", outcome: LOST, text: "First message", images: [{ name: "first.png" }], key: "k1" }]);
});

test("a rejection into an empty draft restores it, with its key only when a retry must reuse it", () => {
	const [sent, first] = takeDraft(start("A", [{ name: "a.png" }]), "k2");
	assert.deepEqual(giveBack(sent, first, { id: "r1", outcome: LOST, newKey: keys() }), { draft: first, returned: [], notices: [{ id: "r1", text: "A", key: "k1", outcome: LOST }] });
	assert.deepEqual(giveBack(sent, first, { id: "r1", outcome: REFUSED, newKey: keys() }).draft, { ...first, key: "n1" }, "a final refusal comes back as a new message");
	assert.deepEqual(giveBack(sent, first, { id: "r1", outcome: LOST, newKey: keys(), hold: true }).returned.map((r) => r.text), ["A"], "held when the owner is elsewhere");
});

test("rapid sends each keep their own content and key", () => {
	const [one, a] = takeDraft(start("A"), "k2");
	const [two, b] = takeDraft({ ...one, draft: { ...one.draft, text: "B" } }, "k3");
	assert.deepEqual([a.key, b.key, two.draft.key], ["k1", "k2", "k3"]);
	// Both fail late, in reverse order; neither replaces the other or the draft.
	const typed = { ...two, draft: { ...two.draft, text: "C" } };
	const back = giveBack(giveBack(typed, b, { id: "rb", outcome: LOST, newKey: keys() }), a, { id: "ra", outcome: LOST, newKey: keys() });
	assert.equal(back.draft.text, "C");
	assert.deepEqual(back.returned.map((r) => r.text), ["B", "A"]);
});

test("restoring a returned message merges it ahead of the draft and keeps refused images held", () => {
	const held: Custody<Img> = { draft: { text: "Now", images: [{ name: "now.png" }], key: "k9" }, returned: [{ id: "r1", outcome: LOST, text: "Then", images: [{ name: "a.png" }, { name: "b.png" }], key: "k1" }] };
	const admitOne = (_current: readonly Img[], incoming: readonly Img[]) => ({ accepted: incoming.slice(0, 1), rejected: incoming.slice(1) });
	const partial = restoreReturned(held, "r1", admitOne, keys());
	assert.deepEqual(partial.draft, { text: "Then\n\nNow", images: [{ name: "now.png" }, { name: "a.png" }], key: "n1" }, "a merged restore is a new payload under a new key");
	assert.deepEqual(partial.returned, [{ id: "r1", outcome: LOST, text: "", images: [{ name: "b.png" }], key: "n2" }], "a refused image stays held, never dropped");
	const all = restoreReturned(held, "r1", (_c, incoming) => ({ accepted: [...incoming], rejected: [] }), keys());
	assert.deepEqual(all.returned, []);
	assert.equal(restoreReturned(held, "missing", admitOne, keys()), held);
});

// The outcome invariant: custody owns outcome certainty in every placement; the Composer only presents `Outcome`.
test("outcome: every placement and lifecycle keeps the submission's outcome", () => {
	const [sent, first] = takeDraft(start("A"), "k2");
	const back = giveBack(sent, first, { id: "r1", outcome: LOST, newKey: keys() });
	assert.deepEqual(back.notices, [{ id: "r1", text: "A", key: "k1", outcome: LOST }], "into the empty draft, as a notice on its text");
	assert.equal(giveBack(sent, first, { id: "r1", outcome: LOST, newKey: keys(), quiet: true }).notices, undefined, "a choice that states the outcome leaves no notice");
	const newer = giveBack({ ...sent, draft: { ...sent.draft, text: "Newer" } }, first, { id: "r1", outcome: LOST, newKey: keys() });
	assert.deepEqual(newer.returned[0]!.outcome, LOST, "held beside a newer draft, still uncertain");
	assert.equal(newer.notices, undefined, "a held record adds no draft notice");
	assert.deepEqual(editDraft(back, { text: "A!" }, keys()).notices?.map((n) => n.outcome), [LOST], "an edit keeps the warning while the text stays");
	assert.deepEqual(editDraft(back, { text: "" }, keys()).notices?.map((n) => n.outcome), [LOST], "an uncertain send stays uncertain when its text leaves the draft");
	assert.equal(takeDraft(back, "k4")[0].notices, undefined, "a send ends the notice");
	const refused = giveBack(sent, first, { id: "r1", outcome: REFUSED, newKey: keys(), hold: true });
	assert.deepEqual(restoreReturned(refused, "r1", (_c, incoming) => ({ accepted: [...incoming], rejected: [] }), keys()).notices?.map((n) => n.outcome), [REFUSED], "a restore carries the record's outcome");
	// The key follows the outcome: the retry key and intent stay exactly when the outcome is uncertain.
	assert.equal(giveBack(sent, first, { id: "r1", outcome: LOST, newKey: keys(), hold: true }).returned[0]!.key, "k1");
	assert.equal(refused.returned[0]!.key, "n1");
});

// The retry promise names one identity: it shows exactly while the payload holds the key and intent it went out under.
test("outcome: a rekey ends the retry promise and keeps the uncertainty", () => {
	const lost: Outcome = { uncertain: true, text: "devbox did not answer.", once: "Send again delivers it once." };
	const promise = "devbox did not answer. Send again delivers it once.", unsure = `devbox did not answer. ${MAYBE_SENT}`;
	const said = (c: Custody<Img>) => c.notices!.map((n) => outcomeText(n.outcome, noticeKeyed(c.draft, n)));
	const intent = { whenBusy: "followUp" as const };
	const [sent, first] = takeDraft({ draft: { text: "A", images: [], key: "k1", intent }, returned: [] }, "k2");
	const back = giveBack(sent, first, { id: "r1", outcome: lost, newKey: keys() });
	assert.deepEqual(said(back), [promise], "a whole give-back keeps the key");
	assert.deepEqual(said(editDraft(back, { text: "A, edited" }, keys())), [unsure], "an edit");
	assert.deepEqual(said(editDraft(back, { text: "Other" }, keys())), [unsure], "an edit that removes the text");
	const held = giveBack(sent, first, { id: "r1", outcome: lost, newKey: keys(), hold: true });
	assert.equal(outcomeText(lost, !!held.returned[0]!.intent), promise, "a held record keeps the key");
	const admitAll = (_c: readonly Img[], incoming: readonly Img[]) => ({ accepted: [...incoming], rejected: [] });
	assert.deepEqual(said(restoreReturned(held, "r1", admitAll, keys())), [promise], "a whole restore keeps the key");
	const merged = restoreReturned({ ...held, draft: { text: "Newer", images: [], key: "k2" } }, "r1", admitAll, keys());
	assert.deepEqual(said(merged), [unsure], "a merge");
	const partial = restoreReturned({ ...giveBack(sent, { ...first, images: [{ name: "a.png" }] }, { id: "r1", outcome: lost, newKey: keys(), hold: true }) }, "r1", () => ({ accepted: [], rejected: [{ name: "a.png" }] }), keys());
	assert.equal(outcomeText(lost, !!partial.returned[0]!.intent), unsure, "a held remainder");
	assert.equal(outcomeText({ uncertain: false, text: "Not sent: no." }, false), "Not sent: no.", "a refusal has no promise to end");
});
