// The browser side of the hub protocol: one WebSocket, request/response, and replicated subscriptions. Views are
// render-only replicas: a snapshot followed by chord delta ops, replaced wholesale after a host reconnects.

import { native } from "./native.ts";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { HostState as HubHostState } from "../../src/hub/hosts.ts";
import { STALE_VERSION, type ClientOps, type HubOps, type Pin, type Topic, type TopicValue } from "../../src/shared/protocol.ts";
import { perfMark, perfMarkOnce } from "./perf.ts";

export type HostState = HubHostState & { link: string };

export { findHost } from "./components/host-label.ts";

/** The wire code of a refused request (protocol.ts STALE_VERSION, NOT_FOUND, ...). */
export const refusal = (error: unknown) => (error as { code?: string } | undefined)?.code;

/** Reads of one versioned request before the caller's refresh: the first, then two at the version `next` returns. */
export const STALE_READS = 3;
/**
 * A read pinned to a source version. A `stale_version` refusal reads again at the version `next` returns, at most
 * STALE_READS reads. Then `refresh`, when given, replaces the caller's view once, and one last read follows it. Every
 * other refusal, and the last stale one, reach the caller.
 */
export async function readVersioned<T>(read: (version: string | undefined) => Promise<T>, version: string | undefined, next: (stale: string | undefined) => Promise<string | undefined>, refresh?: () => void): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try { return await read(version); }
		catch (error) {
			if (refusal(error) !== STALE_VERSION || attempt > STALE_READS || (attempt === STALE_READS && !refresh)) throw error;
			if (attempt === STALE_READS) refresh!();
			version = await next(version);
		}
	}
}
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
	/** Whether the hub has listed its Hosts; until then a route's Host ID resolves to no link key. */
	hostsListed = false;
	/** The hub.json the hub read at start (hosts frame). */
	config: string | undefined;
	/** The hub's pinned Sessions (src/hub/pins.ts); replaced whole by each `pins` frame. */
	pins: Pin[] = [];
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
				this.hosts = (frame.hosts as HubHostState[]).map((h) => ({ ...h, link: h.link ?? h.id }));
				this.hostsListed = true;
				this.config = frame.config as string | undefined;
				this.#emit();
				return;
			case "pins":
				this.pins = frame.pins;
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
				// A gap or a duplicate stream: this replica no longer matches the node. Start over from a snapshot.
				if (frame.n !== sub.n + 1) return this.#restart(sub);
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

	#restart(sub: Sub): void {
		sub.n = -1;
		this.#send({ t: "unsub", sid: sub.sid });
		this.#send({ t: "sub", sid: sub.sid, host: sub.host, topic: sub.topic });
	}

	/** Replaces an open replica with a fresh snapshot, as after a stream gap. False when no one holds the topic. */
	refresh(host: string, topic: Topic): boolean {
		const sub = this.subsByKey.get(`${host}|${JSON.stringify(topic)}`);
		if (sub) this.#restart(sub);
		return Boolean(sub);
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

/** The clock for link elapsed and retry times: it ticks each second while `active` and holds otherwise. */
export function useNow(active: boolean): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

export function useHosts(): { hosts: HostState[]; connected: boolean; listed: boolean } {
	const subscribe = (listener: () => void) => hub.subscribeHosts(listener);
	const hosts = useSyncExternalStore(subscribe, () => hub.hosts);
	const connected = useSyncExternalStore(subscribe, () => hub.connected);
	const listed = useSyncExternalStore(subscribe, () => hub.hostsListed);
	return { hosts, connected, listed };
}

/** The hub's pinned Sessions, in pin order. */
export function usePins(): Pin[] {
	return useSyncExternalStore((listener: () => void) => hub.subscribeHosts(listener), () => hub.pins);
}

/**
 * Moves a pin's host hint to the Host that lists the Session. Only the hub changes the hint, and only for a Session
 * that is still pinned; a refused hint changes nothing the owner chose, so it is not shown.
 */
export function hintPin(host: string, threadId: string): void {
	void hub.hub("pins.hint", { host, threadId }).catch((error) => console.warn(`pin hint: ${(error as Error).message}`));
}

/**
 * Sends the owner's intent for one Session, pinned or not, as the clicked control offered it; every window gets the new
 * list. Only the star, the row menu and the × call it. A refusal reaches the owner as an alert.
 */
export function setPin(host: string, threadId: string, pinned: boolean, title?: string): void {
	void hub.hub("pins.set", { host, threadId, pinned, intent: "owner", ...(title ? { title } : {}) }).catch((error) => alert(`Could not ${pinned ? "pin" : "unpin"}: ${(error as Error).message}`));
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

