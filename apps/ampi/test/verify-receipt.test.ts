import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

// The script is untyped .mjs; a URL specifier keeps it out of the TypeScript project.
type CommitRecord = { requested: string | null; actual: string | null; failure: string | null };
const { commitRecord, receiptCommit } = (await import(new URL("../scripts/verify/receipt.mjs", import.meta.url).href)) as {
	commitRecord(hashes: { requested?: string | null; actual?: string | null }): CommitRecord;
	receiptCommit(receipt: Record<string, unknown>): CommitRecord;
};

const A = "a".repeat(40), B = "b".repeat(40);

test("verify receipt: the tested commit is recorded as requested and actual, and agrees", () => {
	assert.deepEqual(commitRecord({ requested: A, actual: A }), { requested: A, actual: A, failure: null });
});

test("verify receipt: a run whose hub reads another commit fails and names both hashes", () => {
	const r = commitRecord({ requested: A, actual: B });
	assert.deepEqual([r.requested, r.actual], [A, B]);
	assert.match(r.failure ?? "", new RegExp(`tested commit ${B.slice(0, 12)}.* requested ${A.slice(0, 12)}`));
});

test("verify receipt: a run that cannot read either hash fails with a clear reason", () => {
	assert.match(commitRecord({ requested: A, actual: null }).failure ?? "", /could not read the tested commit/);
	assert.match(commitRecord({ requested: A, actual: "not-a-hash" }).failure ?? "", /could not read the tested commit/);
	assert.match(commitRecord({ requested: undefined, actual: A }).failure ?? "", /could not read the requested commit/);
});

test("verify receipt: a receipt written before this check, with only a revision, fails as unreadable", () => {
	// The top-level shape of an older receipt: the tested commit is only a `revision` field.
	const old = { schema: "ampi-verify-run/1", runId: "run-old", revision: A, port: 1, journeys: [] };
	const r = receiptCommit(old);
	assert.deepEqual([r.requested, r.actual], [null, null]);
	assert.match(r.failure ?? "", /could not read the requested commit/);
	assert.equal(receiptCommit({ ...old, requested: A, actual: A }).failure, null);
});
