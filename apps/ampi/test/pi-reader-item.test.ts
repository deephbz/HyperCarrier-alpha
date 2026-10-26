import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-ignore: shared reader is plain ESM.
import { openPiSessionRange } from "../../trace-analytics/src/sources/transcript-range.mjs";
import { inheritedBefore, visitFindItems, visitIngestItems, type IngestSemantics, type ReaderItem } from "../src/pi/reader-item.ts";

const T = "2026-10-24T08:00:00.000Z";
const rows = [
	{ type: "session", version: 3, id: "sess-bridge", timestamp: T, cwd: "/work/synthetic", parentSession: "/work/parent.jsonl" },
	{ type: "message", id: "u1", parentId: null, timestamp: T, message: { role: "user", content: "Check the reader bridge." } },
	{ type: "message", id: "inj", parentId: "u1", timestamp: T, message: { role: "user", content: "[PiTeams clarification] A coordination notice." } },
	{ type: "custom_message", id: "cm", parentId: "inj", timestamp: T, customType: "hc-note", content: "An injected notice.", display: true },
	{ type: "model_change", id: "mc", parentId: "cm", timestamp: T, provider: "openai", modelId: "gpt-5.5" },
	{ type: "message", id: "a1", parentId: "mc", timestamp: T, message: { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "Plan." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] } },
	{ type: "compaction", id: "k", parentId: "a1", timestamp: T, summary: "## Goal\nKeep going.", firstKeptEntryId: "a1", tokensBefore: 1000 },
	{ type: "message", id: "a2", parentId: "k", timestamp: T, message: { role: "assistant", stopReason: "error", errorMessage: "529 overloaded", content: [] } },
	{ type: "custom", id: "lin", parentId: "a2", timestamp: T, customType: "rarebit-fork-lineage", data: { schemaVersion: 1, opening: { seedEntryId: "u1" }, importedEntryIds: ["u1"], extra: "dropped" } },
];

function items(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "ampi-reader-item-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "bridge.jsonl");
	writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	return { file, dir, open: () => openPiSessionRange(file, { host: "fixture", indexPath: join(dir, "index.json") }) };
}

test("reader item: the Pi bridge carries the semantics ingestion derives from, and no native payload", async (t) => {
	const { open } = items(t);
	const reader = open();
	try {
		await reader.refresh();
		const seen: ReaderItem<IngestSemantics>[] = [];
		visitIngestItems(reader, (item) => seen.push(item));
		assert.deepEqual(seen.map((item) => Object.keys(item).sort()), seen.map(() => ["entry", "position", "semantics"]));
		const by = new Map(seen.map((item) => [item.entry.id, item.semantics]));
		// A human turn is a Rarebit item. An injected user message keeps the selector's occurrence but is no item.
		assert.equal(by.get("u1")!.rarebit.item?.kind, "user");
		assert.equal(by.get("inj")!.rarebit.occurrence?.outcome, "user");
		assert.equal(by.get("inj")!.rarebit.item, null);
		assert.equal(by.get("cm")!.rarebit.occurrence, null);
		assert.equal(by.get("mc")!.lineage.model, "openai/gpt-5.5");
		assert.equal(by.get("u1")!.lineage.model, undefined);
		assert.equal(by.get("a1")!.proseCounts.thinking, "Plan.".length);
		assert.equal(by.get("a1")!.proseCounts.toolCalls, JSON.stringify({ command: "npm test" }).length + "bash".length);
		assert.deepEqual(by.get("k")!.rarebit.item, { id: "k", kind: "compaction", t: T, text: "Context restarts here" });
		assert.equal(by.get("k")!.proseCounts.summary, "## Goal\nKeep going.".length);
		assert.deepEqual(by.get("a2")!.rarebit.item, { id: "a2", kind: "error", t: T, text: "529 overloaded" });
		// The lineage record keeps only the fields Rarebit's lineage reader reads.
		assert.deepEqual(by.get("lin")!.lineage, { id: "lin", type: "custom", customType: "rarebit-fork-lineage", data: { schemaVersion: 1, opening: { seedEntryId: "u1" }, importedEntryIds: ["u1"] } });
		assert.equal(inheritedBefore(reader.session()), Date.parse(T) - 1000);
		assert.ok(Number.isNaN(inheritedBefore({ header: { timestamp: T } })));
		// An incremental visit starts after the given entry.
		const after: string[] = [];
		visitIngestItems(reader, (item) => after.push(item.entry.id), { after: "k" });
		assert.deepEqual(after, ["a2", "lin"]);
	} finally {
		reader.close();
	}
});

test("reader item: Find matches the bridge's text, which covers tool calls", async (t) => {
	const { open } = items(t);
	const reader = open();
	try {
		await reader.refresh();
		const text = new Map<string, string>();
		visitFindItems(reader, (item) => text.set(item.entry.id, item.semantics.findText));
		assert.match(text.get("a1")!, /npm test/);
		assert.match(text.get("cm")!, /injected notice/);
	} finally {
		reader.close();
	}
});
