// An in-process JSON value that the node owns and changes through drafts, with ordered change notifications. It
// replaces Chord v1's `replicatedState(initial)`, which Chord 1.6.0 removed with the rest of Chord v1. The node keeps
// the thread rows here (runtime.ts `threads`); the `threads` topic streams them (server.ts `fromState`).

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { type Draft, track } from "@earendil-works/chord/delta";

/**
 * A value that the node reads at once and that subscribers follow in change order.
 *
 * Subscribe contract, as Chord v1's replicated state had it:
 * - `subscribe` calls the listener at once with the current value and the background context (hydration). A reader
 *   that captured `value` earlier and subscribes later therefore gets every change made in between.
 * - After that, the listener gets each later value in change order, with the changing context. It never gets a value
 *   older than one it already got, also when it subscribes from inside another listener.
 * - Listeners are synchronous. A listener that throws is reported and keeps its subscription.
 */
export interface NodeState<T> {
	readonly value: T;
	/** Calls `listener` with the current value, then with each later value. Returns the unsubscribe function. */
	subscribe(listener: (value: T, context: Context) => void): () => void;
}

/** A node state that the node changes through a synchronous draft callback. */
export interface MutableNodeState<T extends object> extends NodeState<T> {
	/** Applies `mutate` to a draft of the value. A change that produces no operations notifies nobody. */
	change(context: Context, mutate: (draft: Draft<T>) => void): void;
}

/**
 * Creates a mutable node state with `initial` as its value. A change from inside a listener is published after the
 * current one, in order. The queue grows only through such changes, because every listener is synchronous.
 */
export function nodeState<T extends object>(initial: T, reportError: (error: unknown) => void = reportLater): MutableNodeState<T> {
	const tracker = track(initial);
	// Each listener with the sequence of the newest value it got. Every change takes the next sequence.
	const listeners = new Map<(value: T, context: Context) => void, number>();
	const queue: { value: T; context: Context; sequence: number }[] = [];
	let sequence = 0;
	let changing = false;
	let delivering = false;
	const call = (listener: (value: T, context: Context) => void, value: T, context: Context) => {
		try {
			listener(value, context);
		} catch (error) {
			reportError(error);
		}
	};
	const publish = (value: T, context: Context) => {
		queue.push({ value, context, sequence: ++sequence });
		if (delivering) return;
		delivering = true;
		try {
			for (let next = queue.shift(); next !== undefined; next = queue.shift())
				for (const [listener, seen] of [...listeners]) {
					// A listener that left, or that hydrated at this sequence or later, skips this value.
					if (listeners.get(listener) !== seen || seen >= next.sequence) continue;
					listeners.set(listener, next.sequence);
					call(listener, next.value, next.context);
				}
		} finally {
			delivering = false;
		}
	};
	return {
		get value() {
			return tracker.value;
		},
		subscribe(listener) {
			listeners.set(listener, sequence);
			call(listener, tracker.value, BACKGROUND_CONTEXT);
			return () => {
				listeners.delete(listener);
			};
		},
		change(context, mutate) {
			if (changing) throw new Error("A node state cannot be changed from inside its own change callback");
			changing = true;
			let prepared;
			try {
				const change = tracker.beginChange();
				try {
					const outcome: unknown = mutate(change.state);
					if (outcome instanceof Promise) throw new TypeError("A node state change callback must be synchronous");
					prepared = change.prepare();
				} catch (error) {
					change.abort();
					throw error;
				}
			} finally {
				changing = false;
			}
			tracker.adopt(prepared);
			if (prepared.ops.length > 0) publish(prepared.value, context);
		},
	};
}

function reportLater(error: unknown): void {
	queueMicrotask(() => {
		throw error;
	});
}
