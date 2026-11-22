// The node state's subscribe contract (src/node/node-state.ts) and the `threads` topic over it (src/node/server.ts).
// A subscriber gets the current value at once, then every later value in order and never an older one, so a
// change in the gap between a topic's creation and its subscription reaches the client.
import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { apply, type Op } from "@earendil-works/chord/delta";
import type { NodeFrame } from "../src/shared/protocol.ts";
import { nodeState } from "../src/node/node-state.ts";
import { Connection } from "../src/node/server.ts";
import type { NodeRuntime } from "../src/node/runtime.ts";

type Rows = { threads: Record<string, { activity: string }> };

test("a threads subscriber sees a change made between the topic's creation and its subscription", async () => {
	const threads = nodeState<Rows>({ threads: { a: { activity: "idle" } } });
	const runtime = { info: { nodeId: "n" }, plugins: [], threads } as unknown as NodeRuntime;
	const frames: NodeFrame[] = [];
	const connection = new Connection(runtime, (frame) => frames.push(frame));
	// The topic handler runs synchronously up to #subscribe's await; this change lands in that gap.
	connection.receive({ t: "sub", sid: 1, topic: { kind: "threads" } });
	threads.change(BACKGROUND_CONTEXT, (draft) => {
		draft.threads.a!.activity = "streaming";
	});
	await new Promise((resolve) => setImmediate(resolve));
	let value: unknown;
	for (const frame of frames) {
		if (frame.t === "snap" && frame.sid === 1) value = frame.value;
		if (frame.t === "ops" && frame.sid === 1) value = apply(value, frame.ops as Op[]);
	}
	assert.deepEqual(value, threads.value, "the client value equals the node value without any later change");
});

test("subscribe calls the listener at once with the current value", () => {
	const state = nodeState({ n: 1 });
	const seen: number[] = [];
	state.subscribe((value) => seen.push(value.n));
	state.change(BACKGROUND_CONTEXT, (draft) => {
		draft.n = 2;
	});
	assert.deepEqual(seen, [1, 2]);
});

test("a listener that subscribes during a delivery never sees a value older than its first one", () => {
	const state = nodeState({ n: 0 });
	const late: number[] = [];
	// While n = 1 is delivered, the first listener queues n = 2 and n = 3; the second then subscribes a late listener.
	state.subscribe((value) => {
		if (value.n !== 1) return;
		for (const n of [2, 3])
			state.change(BACKGROUND_CONTEXT, (draft) => {
				draft.n = n;
			});
	});
	state.subscribe((value) => {
		if (value.n === 1) state.subscribe((next) => late.push(next.n));
	});
	state.change(BACKGROUND_CONTEXT, (draft) => {
		draft.n = 1;
	});
	assert.equal(state.value.n, 3);
	// The late listener hydrates with n = 3; the queued n = 2 and n = 3 are older or equal, so it gets neither.
	assert.deepEqual(late, [3]);
});

test("a listener that throws is reported and keeps its subscription", () => {
	const errors: unknown[] = [];
	const state = nodeState({ n: 0 }, (error) => errors.push(error));
	const seen: number[] = [];
	state.subscribe((value) => {
		seen.push(value.n);
		throw new Error(`boom ${value.n}`);
	});
	state.change(BACKGROUND_CONTEXT, (draft) => {
		draft.n = 1;
	});
	assert.deepEqual(seen, [0, 1]);
	assert.deepEqual(errors.map((error) => (error as Error).message), ["boom 0", "boom 1"]);
});

test("a change that produces no operations notifies nobody", () => {
	const state = nodeState({ n: 0 });
	let calls = 0;
	state.subscribe(() => calls++);
	state.change(BACKGROUND_CONTEXT, (draft) => {
		draft.n = 0;
	});
	assert.equal(calls, 1, "only the first call on subscribe");
});
