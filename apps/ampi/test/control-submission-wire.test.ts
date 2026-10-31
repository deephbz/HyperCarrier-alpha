import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControlSubmission } from "../src/shared/protocol.ts";
import { control } from "./pi-fixtures.ts";
import { setup } from "./pi-host-fixtures.ts";

// A control's submission record reaches the hub with every field, on the status path and the Stop path, through the
// real remote agent. `Required` makes this record name each ControlSubmission field: a new field must appear here, and
// a projection that drops it fails the comparison.
test("a control submission keeps every field through the remote agent on the status and Stop paths", async (t) => {
	const { f, browser } = await setup(t);
	const ctl = await control(f, f.sessionA, { images: true, queue: true });
	t.after(() => ctl.close());
	const record: Required<ControlSubmission> = { submission: "sub-full", deliverAs: "steer", state: "queued", at: 1_700_000_000_000, entryId: "e-7", text: "Two images", truncated: true, images: 2 };
	const delivered: ControlSubmission = { submission: "sub-done", deliverAs: "followUp", state: "delivered", at: 1_700_000_000_001, entryId: "e-8", images: 1 };
	(ctl.submissions as unknown[]).push({ ...record }, { ...delivered, text: "In the Session file", truncated: true });
	const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
	const listed = await browser.until<any>(thread, (v) => v.inbox?.items?.some((item: any) => item.id === record.submission));
	assert.deepEqual(listed.inbox.items.find((item: any) => item.id === record.submission), { id: "sub-full", mode: "steer", content: "Two images", state: "queued", truncated: true, images: 2 }, "status path");
	assert.equal(listed.inbox.items.some((item: any) => item.id === delivered.submission), false, "a delivered submission leaves the queue");
	const stopped = await browser.req("devbox", "thread.abort", { threadId: "pi:sess-a" });
	assert.deepEqual(stopped.submissions, [{ ...record, state: "returned" }], "Stop path");
	// The fixture's status reports the settled records too; a delivered one carries no text.
	const settled = await browser.until<any>(thread, (v) => v.inbox?.items?.some((item: any) => item.id === record.submission && item.state === "returned"));
	assert.deepEqual(settled.inbox.items.find((item: any) => item.id === record.submission), { id: "sub-full", mode: "steer", content: "Two images", state: "returned", truncated: true, images: 2 }, "returned path");
});
