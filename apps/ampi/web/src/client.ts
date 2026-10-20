// The browser side of the hub protocol: one WebSocket, request/response, and replicated subscriptions. Views are
// render-only replicas: a snapshot followed by chord delta ops, replaced wholesale after a host reconnects.

import { native } from "./native.ts";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { useSyncExternalStore } from "react";
import type { HostState } from "../../src/hub/hosts.ts";
import type { ClientOps, HubOps, Topic, TopicValue } from "../../src/shared/protocol.ts";
import { perfMark, perfMarkOnce } from "./perf.ts";

export type { HostState };
/** An op's arguments as a rest tuple: optional when every field is. */
type Args<A> = {} extends A ? [args?: A] : [args: A];

type Sub = {
	sid: number;
	key: string;
	host: string;
	topic: Topic;
	value: unknown;
	/** Last ops frame applied since the snapshot; -1 while a resync is pending. */
	n: number;
	stale: boolean;
	error?: string;
	refs: number;
	listeners: Set<() => void>;
	snapshot: { value: unknown; stale: boolean; error?: string };
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class HubClient {
	#ws?: WebSocket;
	#id = 1;
	#pending = new Map<number, Pending>();
	readonly subsByKey = new Map<string, Sub>();
	#bySid = new Map<number, Sub>();
	#listeners = new Set<() => void>();
	hosts: HostState[] = [];
	connected = false;
	#retry = 0;

	constructor(readonly url: string) {
		this.#open();
	}

	#open(): void {
		const ws = new WebSocket(this.url);
		this.#ws = ws;
		let opened = false;
		ws.onopen = () => {
			opened = true;
			perfMark("ws-open");
			this.connected = true;
			this.#retry = 0;
			for (const sub of this.subsByKey.values()) ws.send(JSON.stringify({ t: "sub", sid: sub.sid, host: sub.host, topic: sub.topic }));
			this.#emit();
		};
		ws.onclose = () => {
			if (!opened) void this.#reportAuthRefused();
			this.connected = false;
			for (const pending of this.#pending.values()) pending.reject(new Error("AmPi hub connection lost"));
			this.#pending.clear();
			for (const sub of this.subsByKey.values()) this.#update(sub, { stale: true });
			this.#emit();
			setTimeout(() => this.#open(), Math.min(5000, 300 * 2 ** this.#retry++));
		};
		ws.onmessage = (event) => this.#frame(JSON.parse(String(event.data)));
	}

	#authChecked = false;
	/**
	 * A WebSocket closed before it opened: the hub is down, or it refused this page's login cookie (a key rotated while
	 * AmPi.app ran). Health answers with `hosts` only to an authorized caller, so a reachable hub without `hosts` means a
	 * refused cookie; AmPi.app then signs in once with its key link. Once per page load; a browser has no bridge.
	 */
	async #reportAuthRefused(): Promise<void> {
		const shell = native();
		if (!shell || this.#authChecked) return;
		const health = await fetch("/api/health", { cache: "no-store" }).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined);
		if (!health || "hosts" in health) return;
		this.#authChecked = true;
		shell.postMessage({ type: "auth-refused" });
	}

	// biome-ignore lint: frames are loosely typed JSON
	#frame(frame: any): void {
		switch (frame.t) {
			case "hosts":
				this.hosts = frame.hosts;
				this.#emit();
				return;
			case "res": {
				const pending = this.#pending.get(frame.id);
				if (!pending) return;
				this.#pending.delete(frame.id);
				if (frame.ok) pending.resolve(frame.value);
				else pending.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
				return;
			}
			case "snap": {
				const sub = this.#bySid.get(frame.sid);
				if (sub) {
					sub.n = 0;
					this.#update(sub, { value: frame.value, stale: false, error: undefined });
					perfMarkOnce("first-data");
				}
				return;
			}
			case "ops": {
				const sub = this.#bySid.get(frame.sid);
				if (!sub || sub.value === undefined || sub.n === -1) return;
				if (frame.n !== sub.n + 1) {
					// A gap or a duplicate stream: this replica no longer matches the node. Start over from a snapshot.
					sub.n = -1;
					this.#send({ t: "unsub", sid: sub.sid });
					this.#send({ t: "sub", sid: sub.sid, host: sub.host, topic: sub.topic });
					return;
				}
				sub.n = frame.n;
				this.#update(sub, { value: applyImmutable(sub.value, frame.ops as Op[]) });
				return;
			}
			case "stale": {
				const sub = this.#bySid.get(frame.sid);
				if (sub) this.#update(sub, { stale: true });
				return;
			}
			// A pending subscription stays open: the next snap clears the error.
			case "pending":
			case "end": {
				const sub = this.#bySid.get(frame.sid);
				if (sub) this.#update(sub, { error: frame.reason, stale: true });
				return;
			}
		}
	}

	#update(sub: Sub, change: Partial<Pick<Sub, "value" | "stale" | "error">>): void {
		Object.assign(sub, change);
		sub.snapshot = { value: sub.value, stale: sub.stale, ...(sub.error ? { error: sub.error } : {}) };
		for (const listener of sub.listeners) listener();
	}

	/** Sends now or not at all: subscriptions are re-sent from the registry on reconnect, requests fail fast. */
	#send(frame: unknown): boolean {
		if (this.#ws?.readyState !== WebSocket.OPEN) return false;
		this.#ws.send(JSON.stringify(frame));
		return true;
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}

	subscribeHosts(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Requests an op of a host. `ClientOps` types its arguments and result; ops whose arguments are all optional may omit them. */
	request<K extends keyof ClientOps>(host: string, op: K, ...[args = {}]: Args<ClientOps[K]["args"]>): Promise<ClientOps[K]["result"]> {
		const id = this.#id++;
		return new Promise<ClientOps[K]["result"]>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			// Never queue an action for later: a request the owner saw fail must not run after a reconnect.
			if (!this.#send({ t: "req", id, host, op, args })) {
				this.#pending.delete(id);
				reject(new Error("Not connected to the AmPi hub"));
			}
		});
	}

	/** Requests an op the hub serves itself (`HubOps`). */
	hub<K extends keyof HubOps>(op: K, args: HubOps[K]["args"]): Promise<HubOps[K]["result"]> {
		const id = this.#id++;
		return new Promise<HubOps[K]["result"]>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			if (!this.#send({ t: "hub", id, op, args })) {
				this.#pending.delete(id);
				reject(new Error("Not connected to the AmPi hub"));
			}
		});
	}

	/** A ref-counted subscription keyed by host and topic. */
	acquire(host: string, topic: Topic): Sub {
		const key = `${host}|${JSON.stringify(topic)}`;
		let sub = this.subsByKey.get(key);
		if (!sub) {
			const sid = this.#id++;
			sub = {
				sid,
				key,
				host,
				topic,
				value: undefined,
				n: 0,
				stale: true,
				refs: 0,
				listeners: new Set(),
				snapshot: { value: undefined, stale: true },
			};
			this.subsByKey.set(key, sub);
			this.#bySid.set(sid, sub);
			this.#send({ t: "sub", sid, host, topic });
		}
		sub.refs++;
		return sub;
	}

	peek(key: string): Sub["snapshot"] | undefined {
		return this.subsByKey.get(key)?.snapshot;
	}

	release(sub: Sub): void {
		sub.refs--;
		if (sub.refs > 0) return;
		// Keep a released subscription warm briefly: switching threads back and forth should not refetch.
		setTimeout(() => {
			if (sub.refs > 0 || !this.subsByKey.has(sub.key)) return;
			this.subsByKey.delete(sub.key);
			this.#bySid.delete(sub.sid);
			this.#send({ t: "unsub", sid: sub.sid });
		}, 30_000);
	}
}

const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
export const hub = new HubClient(url);

export function useHosts(): { hosts: HostState[]; connected: boolean } {
	const subscribe = (listener: () => void) => hub.subscribeHosts(listener);
	const hosts = useSyncExternalStore(subscribe, () => hub.hosts);
	const connected = useSyncExternalStore(subscribe, () => hub.connected);
	return { hosts, connected };
}

const EMPTY = { value: undefined, stale: true } as const;

/** A replica of one topic; `TopicValue` types its value from the topic's kind and view. */
export function useTopic<T extends Topic>(host: string | undefined, topic: T | undefined): { value: TopicValue<T> | undefined; stale: boolean; error?: string } {
	const key = host && topic ? `${host}|${JSON.stringify(topic)}` : "";
	const store = useMemoSub(key, host, topic);
	const snapshot = useSyncExternalStore(store.subscribe, store.get);
	// The one decode point: the hub relays what the host published for this topic.
	return snapshot as { value: TopicValue<T> | undefined; stale: boolean; error?: string };
}

const stores = new Map<string, { subscribe: (l: () => void) => () => void; get: () => Sub["snapshot"] | typeof EMPTY }>();

function useMemoSub(key: string, host: string | undefined, topic: Topic | undefined) {
	let store = stores.get(key);
	if (!store) {
		if (!host || !topic) {
			store = { subscribe: () => () => {}, get: () => EMPTY };
		} else {
			let sub: Sub | undefined;
			store = {
				subscribe: (listener) => {
					sub = hub.acquire(host, topic);
					sub.listeners.add(listener);
					return () => {
						sub?.listeners.delete(listener);
						if (sub) hub.release(sub);
					};
				},
				get: () => sub?.snapshot ?? hub.peek(key) ?? EMPTY,
			};
		}
		stores.set(key, store);
	}
	return store;
}

