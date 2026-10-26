import "./bound.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineExtension, defineTask, type Storage } from "@earendil-works/pi-durable";
import { NodeRuntime, parseThreadKey, REOPEN_ATTEMPTS } from "../src/node/runtime.ts";
import { tempHome } from "./helpers.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
function queue<T>() {
	const items: T[] = [], waiters: ((item: T) => void)[] = [];
	return { push(item: T) { const waiter = waiters.shift(); if (waiter) waiter(item); else items.push(item); },
		next: () => items.length ? Promise.resolve(items.shift()!) : new Promise<T>((resolve) => waiters.push(resolve)),
		get length() { return items.length; } };
}
const options = (home: string) => ({ home, agentDir: join(home, "agent"), report: () => {} });
async function thread(runtime: NodeRuntime, requestId: string) {
	return (await runtime.createThread({ requestId, cwd: runtime.home, model: { provider: "ampi-sim", modelId: "sim-1" } })).threadId;
}
async function healthy(runtime: NodeRuntime, id: string) {
	const { conversation } = await runtime.thread(id);
	await conversation.submit({ type: "write", entry: { kind: "test.healthy", data: { okay: true } } }, ctx);
	assert.ok((await conversation.entries({}, 100, undefined, ctx)).items.some((entry) => entry.kind === "test.healthy"));
}

test("recovery caps successful-open/failed-resume cycles and leaves another store serving; manual retry works", { timeout: 10_000 }, async () => {
	const home = tempHome();
	const gate = deferred(), entered = deferred();
	const probe = defineTask<null, { phase: "write" }, null>({
		name: "test.recovery-probe", version: 1, initial: () => ({ phase: "write" }),
		phases: { write: async (_task, api, context) => { entered.resolve(); await gate.promise; await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context); } },
		abort: (_task, api, context) => api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	const actions = queue<{ kind: "timer"; callback: () => void } | { kind: "gaveup" }>();
	const arms = new Map<string, () => void>();
	let broken = "", fail = false, opens = 0;
	const runtime = new NodeRuntime({ ...options(home),
		wrapStorage(id, storage): Storage {
			let armed = false; arms.set(id, () => { armed = true; });
			if (id === broken) opens++;
			return new Proxy(storage, { get(target, prop) {
				const value = Reflect.get(target, prop, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					if (prop === "commit" && armed && fail && id === broken) throw new Error(`first post-resume write failed: ${"x".repeat(400)}`);
					return value.apply(target, args);
				};
			} });
		},
		plugins: [{ extensions: [defineExtension({ name: "test.recovery", tasks: [probe] })], settings: { restartLimit: 100 }, attach: (store) => arms.get(store.id)!() }],
		setTimer: (callback) => actions.push({ kind: "timer", callback }),
	});
	try {
		const bad = await thread(runtime, "bad"), good = await thread(runtime, "good");
		broken = parseThreadKey(bad).storeId;
		const stop = runtime.threads.subscribe(() => { if (runtime.unavailable(broken)?.gaveUp) actions.push({ kind: "gaveup" }); });
		const { store, conversation } = await runtime.thread(bad);
		await store.harness.commit((tx) => tx.createTask(probe, null, { ownership: { kind: "conversation" }, conversationId: conversation.id }), ctx);
		await entered.promise;
		fail = true; gate.resolve();
		for (let attempt = 0; attempt < REOPEN_ATTEMPTS; attempt++) {
			const action = await actions.next(); assert.equal(action.kind, "timer");
			if (action.kind === "timer") action.callback();
		}
		assert.equal((await actions.next()).kind, "gaveup", "successful open must not reset the total recovery budget");
		assert.equal(opens, REOPEN_ATTEMPTS);
		assert.equal(actions.length, 0, "no timer remains after the cap");
		assert.match(runtime.threads.value.threads[bad]!.lastError!, /gave up.*\/retry/);
		assert.equal((await runtime.health()).stores.find((entry) => entry.id === broken)?.gaveUp, true);
		await healthy(runtime, good);
		stop();
		fail = false;
		assert.equal((await runtime.reopenStore(broken)).state, "open");
		await healthy(runtime, bad);
	} finally { gate.resolve(); await runtime.close(); }
});

test("partial open failure removes the store, closes its storage, and allows one clean reopen", { timeout: 10_000 }, async () => {
	const home = tempHome();
	const seed = new NodeRuntime(options(home));
	const bad = await thread(seed, "partial"), good = await thread(seed, "healthy");
	await seed.close();
	const badStore = parseThreadKey(bad).storeId;
	const timers = queue<() => void>();
	let fail = true, closes = 0, opens = 0;
	const runtime = new NodeRuntime({ ...options(home), setTimer: (callback) => timers.push(callback),
		wrapStorage(id, storage) {
			if (id !== badStore) return storage;
			opens++;
			return new Proxy(storage, { get(target, prop) {
				const value = Reflect.get(target, prop, target);
				if (prop === "close") return async (...args: unknown[]) => { closes++; return value.apply(target, args); };
				return typeof value === "function" ? value.bind(target) : value;
			} });
		},
		plugins: [{ extensions: [], attach(store, owner) {
			if (store.id === badStore && fail) { assert.equal(owner.stores.get(badStore), store); throw new Error("startup reconciliation failed"); }
		} }],
	});
	try {
		await runtime.start();
		assert.equal(runtime.stores.has(badStore), false, "failed initialization must not leave a reachable half-open Harness");
		assert.equal(closes, 1);
		assert.equal((await runtime.health()).stores.filter((entry) => entry.id === badStore).length, 1);
		await healthy(runtime, good);
		const restored = deferred();
		const stop = runtime.threads.subscribe(() => { if (runtime.threads.value.threads[bad] && !runtime.threads.value.threads[bad]!.lastError) restored.resolve(); });
		fail = false; (await timers.next())(); await restored.promise; stop();
		assert.equal(opens, 2);
		await healthy(runtime, bad);
	} finally { await runtime.close(); }
});
