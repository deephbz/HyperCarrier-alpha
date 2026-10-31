import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { proseRows } from "../web/src/components/palette-prose.ts";

const hit = (threadId: string, entry: string, title = threadId) => ({ entry, ref: `${threadId}:${entry}`, threadId, snippet: `about ${entry}`, title, version: "v1" });
const result = (hits: ReturnType<typeof hit>[], more = false) => ({ hits, more, scope: "prose", asOf: null });

test("prose rows keep each Host's hit order and name the Host per row", () => {
	const { rows, notes } = proseRows([
		{ host: { link: "a", label: "Alpha" }, value: result([hit("t1", "e1"), hit("t2", "e2")]) },
		{ host: { link: "b", label: "Beta" }, value: result([hit("t3", "e3")]) },
	]);
	assert.deepEqual(rows.map((row) => [row.host, row.hostLabel, row.threadId, row.entry]), [["a", "Alpha", "t1", "e1"], ["a", "Alpha", "t2", "e2"], ["b", "Beta", "t3", "e3"]]);
	assert.deepEqual(notes, []);
});

test("prose notes report a Host that failed or reached its limit", () => {
	const { rows, notes } = proseRows([
		{ host: { link: "a", label: "Alpha" }, error: "Error: away" },
		{ host: { link: "b", label: "Beta" }, value: result([hit("t3", "e3")], true) },
	]);
	assert.equal(rows.length, 1);
	assert.deepEqual(notes, ["Alpha not searched: Error: away", "Beta: limit reached; narrow the query"]);
});

test("an untitled hit falls back to a readable title", () => {
	const { rows } = proseRows([{ host: { link: "a", label: "Alpha" }, value: result([{ ...hit("t1", "e1"), title: "" }]) }]);
	assert.equal(rows[0]!.title, "Untitled Session");
});

test("prose notes name partial coverage and an away Host, so a miss is not read as absence", () => {
	const coverage = { indexed: 4, notIndexed: 2, stale: 1, invalidLines: 3 };
	const { notes } = proseRows([
		{ host: { link: "a", label: "Alpha", status: "disconnected" }, value: { ...result([]), coverage } },
		{ host: { link: "b", label: "Beta", status: "connected" }, value: { ...result([]), coverage: { indexed: 4, notIndexed: 0, stale: 0, invalidLines: 0 } } },
	]);
	assert.deepEqual(notes, ["Alpha: Host away; searched its last copy", "Alpha: 2 copies not indexed · 1 behind source or unavailable · 3 invalid records excluded"]);
});

test("prose notes count the Sessions an upgrade still re-derives, so a miss there is not read as absence", () => {
	const { notes } = proseRows([{ host: { link: "a", label: "Alpha" }, value: { ...result([]), coverage: { indexed: 3, notIndexed: 0, stale: 0, invalidLines: 0, updating: 47 } } }]);
	assert.deepEqual(notes, ["Alpha: searching 3 of 50 Sessions — updating after upgrade"]);
});
