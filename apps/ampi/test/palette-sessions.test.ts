import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { paletteSessions } from "../web/src/components/palette-sessions.ts";

type T = { id: string; title?: string; updatedAt: number; team?: { teamId: string; worker?: string } };
const host = (link: string, threads: T[]) => ({ host: { link }, threads });
const data = [
	host("a", [{ id: "1", title: "Old notes", updatedAt: 1 }, { id: "2", title: "fix palette", updatedAt: 5, team: { teamId: "hc", worker: "astra" } }]),
	host("b", [{ id: "3", title: "Palette review", updatedAt: 3 }]),
];
const ids = (rows: { t: T }[]) => rows.map((r) => r.t.id);

test("an empty query lists recent Sessions first, across Hosts", () => {
	assert.deepEqual(ids(paletteSessions(data, "")), ["2", "3", "1"]);
	assert.deepEqual(ids(paletteSessions(data, "   ", 2)), ["2", "3"]);
});

test("a query ranks prefix, then word start, then inside a word; ties go to the recent Session", () => {
	assert.deepEqual(ids(paletteSessions(data, "pal")), ["3", "2"]);
	assert.deepEqual(ids(paletteSessions(data, "astra")), ["2"]);
	assert.deepEqual(ids(paletteSessions(data, "otes")), ["1"]);
	assert.deepEqual(ids(paletteSessions(data, "zzz")), []);
});
