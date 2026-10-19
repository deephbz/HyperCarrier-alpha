import assert from "node:assert/strict";
import { test } from "node:test";
import { askCandidates, askSentences, isOwnerTurn } from "../src/pi/views/cos-arc-asks.ts";
import type { RarebitItem } from "../src/pi/views/rarebit.ts";

// Synthetic agent stops only; the rule is ask rule v2 (apps/ampi/docs/two-tier-context.md#needs-you-candidates).

test("arc asks phrases: each v2 ask phrase marks its sentence anywhere in a stop (failure: an explicit ask was missed)", () => {
	const phrases = ["Decision needed: pick the cache size.", "Should I merge the branch now.", "Tell me if the alias changed.", "Do you want the old format kept.",
		"May I restart the hub.", "Still open for you: the release name.", "This needs your approval before the push.", "I am waiting for you to confirm the port.",
		"The rollout waits for your go.", "The key rotation is with the owner.", "Pick one of the two layouts.", "The naming is your call.",
		"I will hold the deploy until you tell me.", "To unblock it, add disk to the runner."];
	for (const p of phrases) assert.deepEqual(askSentences(`${p}\n\nThe tests pass.`), [p], p);
	assert.deepEqual(askSentences("The cache landed. Tests pass.\n\nAll done."), [], "plain progress has no ask");
});

test("arc asks questions: a question counts only in the last paragraph or a for-you section (failure: rhetorical questions became asks)", () => {
	assert.deepEqual(askSentences("Why did it fail? A stale lock.\n\nThe fix landed. Which name do you prefer?"), ["Which name do you prefer?"]);
	assert.deepEqual(askSentences("Done.\n\n**Keep the flag?**"), ["**Keep the flag?**"], "a bold question ends with ?**");
	const listed = "Summary of the work.\n\n## Decisions for you\n1. Rename the module?\n2. Drop the legacy path\n\nEverything else is done.";
	assert.deepEqual(askSentences(listed), ["1. Rename the module?", "2. Drop the legacy path"], "items under a for-you heading count, and a list number stays with its item");
});

test("arc asks units: fence lines and table rows never yield asks (failure: tables became asks)", () => {
	assert.deepEqual(askSentences("Result:\n\n```Should I\n```\n\n| Should I | value |\n| Do you want | x |\n\nDone."), []);
});

test("arc asks owner turns: a relayed message counts only when its header names the owner (failure: relayed Worker notes answered asks)", () => {
	assert.equal(isOwnerTurn({ kind: "user", text: "Yes, ship it." }), true);
	assert.equal(isOwnerTurn({ kind: "user", text: "[Worker ctx-builder] status: tests pass" }), false);
	assert.equal(isOwnerTurn({ kind: "user", text: "[relayed from owner] ship it" }), true);
	assert.equal(isOwnerTurn({ kind: "stop", text: "Yes" }), false);
});

test("arc asks candidates: a restated ask keeps one candidate that follows its latest statement (failure: restatements duplicated or reset asks)", () => {
	const items: RarebitItem[] = [
		{ id: "a1", kind: "stop", t: null, text: "Built.\n\nShould I deploy?" },
		{ id: "u1", kind: "user", t: null, text: "Rename the module first." },
		{ id: "a2", kind: "stop", t: null, text: "Renamed.\n\nShould I  deploy?" },
		{ id: "c1", kind: "continuation", t: null, text: "Should I also tidy up?" },
	];
	const { candidates, owners } = askCandidates(items);
	assert.deepEqual(candidates.map((c) => [c.id, c.entryId, c.position, c.entries]), [["q1", "a2", 2, ["a1", "a2"]]], "continuations are not stops");
	assert.deepEqual([...owners], [["u1", 1]]);
});

test("arc asks sections: a for-you section ends at the next heading (failure: status lines under later headings became asks)", () => {
	const stop = "# Review\n\nThe design holds.\n\n## Questions for you\n\n1. Do you accept the branch delivery property?\n2. Can you name an incident?\n\n## Next test\n\nReplay the defect trace.\n\n## Process notes\n\n- I changed no code.\n- I added one line to today's journal.";
	assert.deepEqual(askSentences(stop), ["1. Do you accept the branch delivery property?", "2. Can you name an incident?"]);
	const bold = "**Decisions for you**\n- Keep the old format\n\n**Progress since my last update**\n- The reader landed.\n- Tests pass.";
	assert.deepEqual(askSentences(bold), ["- Keep the old format"], "a bold heading line also ends the section");
});

test("arc asks recall: offers and handed-over decisions are asks (failure: 'Say the word', 'if you want', 'yours to decide' asks were missed)", () => {
	const asks = ["Say the word and I will add the audience selections and commit it.", "I can move them to the archive if you want.", "I will rotate the keys too if you would like.",
		"I changed no files; the fix is yours to decide.", "The rollout timing is up to you to choose.", "The call is yours."];
	for (const a of asks) assert.deepEqual(askSentences(`${a}\n\nJournal line added.`), [a], a);
	const decoys = ["The generator earns its risk if you want scheduled rotation across several regions.", "I can confirm the tests pass.", "It is yours now."];
	for (const d of decoys) assert.deepEqual(askSentences(`${d}\n\nJournal line added.`), [], d);
});

test("arc asks injections: harness-injected user items are not owner turns (failure: Rarebit Recall and team updates could answer asks)", () => {
	for (const text of ["# Rarebit Recall\n\n*Answer the **Current request** only.", "# Message Annotations\n\n# Message F1", "# Markdown Annotations\n\nLine 3", "ptb.team-update: team_sync updates, events 431-433",
		"New intercom message above.", "I have 2 new message(s) in my inbox. Reading them now...", "Restart recovery: call read_inbox once to register readiness"]) assert.equal(isOwnerTurn({ kind: "user", text }), false, text);
	for (const text of ["# Agent runtime vs. agent application\n\nPlease compare the two.", "config.yaml: the port is wrong", "New intercom message above. Also, ship it."]) assert.equal(isOwnerTurn({ kind: "user", text }), true, `an owner message may start like this: ${text}`);
});

test("arc asks port parity: the TS rule keeps rule v2's candidates except its intended divergences (failure: the port drifted from the studied rule)", () => {
	// [case, stop, rule v2 candidates (Python ask_rule.questions(text, "v2")), TS candidates]. Equal rows guard the port;
	// unequal rows are the intended divergences: a for-you section ends at a heading, and offers and handed-over decisions are asks.
	const cases: [string, string, string[], string[]][] = [
		["last-paragraph question", "The reader landed and tests pass.\n\nShould I merge it now?", ["Should I merge it now?"], ["Should I merge it now?"]],
		["for-you list", "Summary of the change.\n\n## Decisions for you\n\n1. Keep the old format.\n2. Which Host gets it first?\n\nJournal line added.", ["1. Keep the old format.", "2. Which Host gets it first?"], ["1. Keep the old format.", "2. Which Host gets it first?"]],
		["mid-message question", "Why did it fail? The cache was cold.\n\nI fixed the warmup.", [], []],
		["status only", "I changed no code.\n\nI added one line to today's journal.", [], []],
		["status list under a later heading", "## Decisions for you\n\n- Approve the rename.\n\n## Status\n\n- I changed no code.\n- I added one line to today's journal.", ["- Approve the rename.", "- I changed no code.", "- I added one line to today's journal."], ["- Approve the rename."]],
		["bold status heading", "**Open for you**\n- Pick the cache size.\n\n**Done:**\n- The reader landed.", ["- Pick the cache size.", "- The reader landed."], ["- Pick the cache size."]],
		["offer: I can … if you want", "The fix is in.\n\nI can also backport it to the release branch if you want.", [], ["I can also backport it to the release branch if you want."]],
		["offer: if you want … I can", "The fix is in.\n\nIf you want, I can also backport it.", [], ["If you want, I can also backport it."]],
		["Say the word", "The draft is ready. Say the word and I will publish it.\n\nJournal line added.", [], ["Say the word and I will publish it."]],
		["handed-over decision", "Both layouts work; the choice is yours.\n\nJournal line added.", [], ["Both layouts work; the choice is yours."]],
	];
	for (const [name, stop, , ts] of cases) assert.deepEqual(askSentences(stop), ts, name);
	assert.equal(cases.filter(([, , v2, ts]) => JSON.stringify(v2) !== JSON.stringify(ts)).length, 6, "six intended divergences, each named above");
	// Rule v2 had no owner-turn test; an injected wake must not count as the owner moving on.
	const { candidates, owners } = askCandidates([{ id: "a1", kind: "stop", t: null, text: "Done.\n\nShould I tag it?" }, { id: "u2", kind: "user", t: null, text: "New intercom message above." }]);
	assert.deepEqual([candidates.map((c) => c.text), [...owners.keys()]], [["Should I tag it?"], []]);
});
