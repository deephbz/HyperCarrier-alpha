import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Custody, type Outcome, MAYBE_SENT, editDraft, giveBack, isEmpty, outcomeText, restoreReturned, takeDraft } from "../web/src/composer-drafts.ts";

type Img = { name: string };
const start = (text: string, images: Img[] = [], key = "k1"): Custody<Img> => ({ draft: { text, images, key }, returned: [] });
const LOST: Outcome = { uncertain: true, text: "devbox did not answer." };
const REFUSED: Outcome = { uncertain: false, text: "Not sent: refused." };
const admitAll = (_current: readonly Img[], incoming: readonly Img[]) => ({ accepted: [...incoming], rejected: [] });
const admitOne = (_current: readonly Img[], incoming: readonly Img[]) => ({ accepted: incoming.slice(0, 1), rejected: incoming.slice(1) });

// The invariant: a submission holds its own content until its outcome; a late outcome never writes over a newer draft.
test("a late rejection keeps the newer draft and holds the returned message beside it", () => {
	const [sent, first] = takeDraft(start("First message", [{ name: "first.png" }]), "k2");
	assert.deepEqual(first, { text: "First message", images: [{ name: "first.png" }], key: "k1" });
	assert.ok(isEmpty(sent.draft) && sent.draft.key === "k2", "a send leaves an empty draft under a new key");
	const typed: Custody<Img> = { ...sent, draft: { ...sent.draft, text: "Next draft", images: [{ name: "next.png" }] } };
	const back = giveBack(typed, first, { id: "r1", outcome: LOST });
	assert.deepEqual(back.draft, typed.draft, "the newer draft is untouched");
	assert.deepEqual(back.returned, [{ id: "r1", outcome: LOST, text: "First message", images: [{ name: "first.png" }], retry: "k1" }]);
});

test("rapid sends each keep their own content and key", () => {
	const [one, a] = takeDraft(start("A"), "k2");
	const [two, b] = takeDraft({ ...one, draft: { ...one.draft, text: "B" } }, "k3");
	assert.deepEqual([a.key, b.key, two.draft.key], ["k1", "k2", "k3"]);
	// Both fail late, in reverse order; neither replaces the other or the draft.
	const typed = { ...two, draft: { ...two.draft, text: "C" } };
	const back = giveBack(giveBack(typed, b, { id: "rb", outcome: LOST }), a, { id: "ra", outcome: LOST });
	assert.equal(back.draft.text, "C");
	assert.deepEqual(back.returned.map((r) => r.text), ["B", "A"]);
});

// The key invariant: a request key names exactly one unchanged payload whose outcome is uncertain.
test("keys: an uncertain outcome restored into an empty draft retries under the same key", () => {
	const [sent, first] = takeDraft(start("A", [{ name: "a.png" }]), "k2");
	assert.deepEqual(giveBack(sent, first, { id: "r1", outcome: LOST }).draft, { ...first, retry: true }, "given straight back");
	const held = giveBack(sent, first, { id: "r1", outcome: LOST, hold: true });
	assert.deepEqual(restoreReturned(held, "r1", admitAll, "k3"), { draft: { ...first, retry: true }, returned: [], notice: LOST }, "restored later");
});

test("keys: a final refusal carries no key, and its restore sends under a new one", () => {
	const [sent, first] = takeDraft(start("A"), "k2");
	assert.deepEqual(giveBack(sent, first, { id: "r1", outcome: REFUSED }).draft, { text: "A", images: [], key: "k2" });
	const held = giveBack(sent, first, { id: "r1", outcome: REFUSED, hold: true });
	assert.deepEqual(held.returned, [{ id: "r1", outcome: REFUSED, text: "A", images: [] }]);
	assert.deepEqual(restoreReturned(held, "r1", admitAll, "k3").draft, { text: "A", images: [], key: "k3" });
});

test("keys: a restore that changes the payload shares no key with what stays held", () => {
	const held: Custody<Img> = { draft: { text: "", images: [], key: "k9" }, returned: [{ id: "r1", outcome: LOST, text: "Then", images: [{ name: "a.png" }, { name: "b.png" }], retry: "k1" }] };
	const partial = restoreReturned(held, "r1", admitOne, "k3");
	assert.deepEqual(partial.draft, { text: "Then", images: [{ name: "a.png" }], key: "k3" });
	assert.deepEqual(partial.returned, [{ id: "r1", outcome: LOST, text: "", images: [{ name: "b.png" }] }], "a refused image stays held, never dropped, and without a key");
	const merged = restoreReturned({ ...held, draft: { text: "Now", images: [{ name: "now.png" }], key: "k9" } }, "r1", admitAll, "k3");
	assert.deepEqual(merged, { draft: { text: "Then\n\nNow", images: [{ name: "now.png" }, { name: "a.png" }, { name: "b.png" }], key: "k3" }, returned: [], notice: LOST });
	assert.equal(restoreReturned(held, "missing", admitOne, "k3"), held);
});

test("keys: the first edit of a draft that holds a retry key gives it a new key", () => {
	const restored = restoreReturned(giveBack(start("", [], "k2"), { text: "A", images: [], key: "k1" }, { id: "r1", outcome: LOST, hold: true }), "r1", admitAll, "k3");
	assert.deepEqual(restored.draft, { text: "A", images: [], key: "k1", retry: true });
	assert.equal(editDraft(restored, { text: "A" }, "k4"), restored, "no change keeps the retry key");
	const edited = editDraft(restored, { text: "A!" }, "k4");
	assert.deepEqual(edited.draft, { text: "A!", images: [], key: "k4" });
	assert.equal(editDraft(edited, { images: [{ name: "x.png" }] }, "k5").draft.key, "k4", "a draft without a retry key keeps its key");
});

// The outcome invariant: custody owns outcome certainty in every placement; the Composer only presents `Outcome`.
test("outcome: every placement and lifecycle keeps the submission's outcome", () => {
	const [sent, first] = takeDraft(start("A"), "k2");
	const back = giveBack(sent, first, { id: "r1", outcome: LOST });
	assert.deepEqual(back, { draft: { ...first, retry: true }, returned: [], notice: LOST }, "into the empty draft, with its outcome as the notice");
	assert.equal(giveBack(sent, first, { id: "r1", outcome: LOST, quiet: true }).notice, undefined, "a choice that states the outcome leaves no notice");
	const newer = giveBack({ ...sent, draft: { ...sent.draft, text: "Newer" } }, first, { id: "r1", outcome: LOST });
	assert.deepEqual(newer.returned[0]!.outcome, LOST, "held beside a newer draft, still uncertain");
	assert.equal(newer.notice, undefined, "a held record does not touch the draft's notice");
	assert.deepEqual(editDraft(back, { text: "A!" }, "k4").notice, LOST, "an edit keeps the warning while the text stays");
	assert.equal(editDraft(back, { text: "" }, "k4").notice, undefined, "an empty draft ends the notice");
	assert.equal(takeDraft(back, "k4")[0].notice, undefined, "a send ends the notice");
	const refused = giveBack(sent, first, { id: "r1", outcome: REFUSED, hold: true });
	assert.deepEqual(restoreReturned(refused, "r1", admitAll, "k3").notice, REFUSED, "a restore carries the record's outcome");
	// The key follows the outcome: a retry key exists exactly when the outcome is uncertain.
	assert.equal(giveBack(sent, first, { id: "r1", outcome: LOST, hold: true }).returned[0]!.retry, "k1");
	assert.equal(refused.returned[0]!.retry, undefined);
});

// The retry promise names one payload: it shows exactly while the payload holds the key it went out under.
test("outcome: a payload change ends the retry promise and keeps the uncertainty", () => {
	const lost: Outcome = { uncertain: true, text: "devbox did not answer.", once: "Send again delivers it once." };
	const promise = "devbox did not answer. Send again delivers it once.", unsure = `devbox did not answer. ${MAYBE_SENT}`;
	const said = (c: Custody<Img>) => c.notice && outcomeText(c.notice, !!c.draft.retry);
	const [sent, first] = takeDraft(start("A"), "k2");
	const back = giveBack(sent, first, { id: "r1", outcome: lost });
	assert.equal(said(back), promise, "a whole give-back keeps the key");
	assert.equal(said(editDraft(back, { text: "A, edited" }, "k4")), unsure, "an edit");
	assert.equal(said(editDraft(back, { text: "Other" }, "k4")), unsure, "an edit that removes the text");
	const held = giveBack(sent, first, { id: "r1", outcome: lost, hold: true });
	assert.equal(outcomeText(lost, !!held.returned[0]!.retry), promise, "a held record keeps the key");
	assert.equal(said(restoreReturned(held, "r1", admitAll, "k3")), promise, "a whole restore keeps the key");
	assert.equal(said(restoreReturned({ ...held, draft: { text: "Newer", images: [], key: "k2" } }, "r1", admitAll, "k3")), unsure, "a merge");
	const partial = restoreReturned(giveBack(sent, { ...first, images: [{ name: "a.png" }, { name: "b.png" }] }, { id: "r1", outcome: lost, hold: true }), "r1", admitOne, "k3");
	assert.equal(said(partial), unsure, "a partial restore");
	assert.equal(outcomeText(partial.returned[0]!.outcome, !!partial.returned[0]!.retry), unsure, "a held remainder");
	const refusedHeld = giveBack(back, { text: "B", images: [], key: "k5" }, { id: "r2", outcome: REFUSED });
	assert.equal(said(restoreReturned(refusedHeld, "r2", admitAll, "k6")), unsure, "a merged refusal keeps the draft's uncertainty");
	assert.equal(outcomeText(REFUSED, false), REFUSED.text, "a refusal has no promise to end");
});
