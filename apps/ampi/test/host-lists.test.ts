import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyNote, reading, unavailable } from "../web/src/host-lists.ts";

// The Overview's empty text from ThreadsState flags and the subscription end reason.
const list = (over: { stale?: boolean; indexing?: boolean; error?: string }) => ({ host: { label: "devbox" }, threads: [], stale: false, ...over });

test("host lists: an empty list says No Sessions yet only after init, and an ended list says why", () => {
	const noDb = list({ indexing: true });
	assert.equal(reading(noDb), true);
	assert.equal(emptyNote([noDb]), "Reading Sessions…", "a no-database start never shows No Sessions yet before init");
	const failed = list({ stale: true, indexing: true, error: "Host cache unavailable: locked. Restart the hub; if it repeats, check the hub log." });
	assert.equal(reading(failed), false, "an ended list never loads further");
	assert.equal(unavailable([failed]), "devbox: Host cache unavailable: locked. Restart the hub; if it repeats, check the hub log.");
	assert.equal(emptyNote([failed]), unavailable([failed]));
	assert.equal(emptyNote([list({})]), "No Sessions yet. Start an agent or add a Host to begin.");
	assert.equal(emptyNote([list({ stale: true })]), "Reading Sessions…");
	assert.equal(unavailable([{ ...failed, threads: [{}] }]), unavailable([failed]), "an ended list says why even with saved rows");
});
