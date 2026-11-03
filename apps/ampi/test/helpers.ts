import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyImmutable } from "@earendil-works/chord/delta";
import WebSocket from "ws";
import { HubHome } from "../src/hub/home.ts";
import { stamp } from "../src/shared/build.ts";
import type { Topic } from "../src/shared/protocol.ts";

export function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "ampi-test-"));
}

/** The home lock for one test hub, as `ampi hub` takes it; release it when the hub stops. */
export function ownHome(dir = tempHome()): HubHome {
	const home = HubHome.acquire(dir);
	assert.ok(home instanceof HubHome, `the home is free: ${JSON.stringify(home)}`);
	return home;
}

/** A minimal browser-side replica client over the hub WebSocket, checking ops continuity like the web client. */
export class Browser {
	values = new Map<number, unknown>();
	seq = new Map<number, number>();
	gaps: string[] = [];
	snaps = new Map<number, number>();
	hosts: any[] = [];
	/** The hosts frame's `config`: the hub.json the hub read at start. */
	config: string | undefined;
	/** The hosts frame's `build`: the hub's build version. */
	build: string | undefined;
	/** The hosts frame's `skipped`: hub.json rows this hub does not serve. */
	skipped: any[] | undefined;
	stale = new Set<number>();
	/** The last `end` or `pending` frame of each subscription. */
	closing = new Map<number, { t: "end" | "pending"; reason: string }>();
	#id = 1;
	#waiters = new Map<number, (frame: any) => void>();
	#listeners = new Set<() => void>();
	readonly ws: WebSocket;
	constructor(ws: WebSocket) {
		this.ws = ws;
		ws.on("message", (data) => {
			const frame = JSON.parse(String(data));
			if (frame.t === "res") this.#waiters.get(frame.id)?.(frame);
			else if (frame.t === "hosts") (this.hosts = frame.hosts), (this.config = frame.config), (this.skipped = frame.skipped), (this.build = frame.build);
			else if (frame.t === "stale") this.stale.add(frame.sid);
			else if (frame.t === "end" || frame.t === "pending") this.closing.set(frame.sid, { t: frame.t, reason: frame.reason });
			else if (frame.t === "snap") {
				this.values.set(frame.sid, frame.value);
				this.seq.set(frame.sid, 0);
				this.stale.delete(frame.sid);
				this.snaps.set(frame.sid, (this.snaps.get(frame.sid) ?? 0) + 1);
			} else if (frame.t === "ops") {
				const expected = (this.seq.get(frame.sid) ?? 0) + 1;
				if (frame.n !== expected) this.gaps.push(`sid ${frame.sid}: ${frame.n} != ${expected}`);
				this.seq.set(frame.sid, frame.n);
				this.values.set(frame.sid, applyImmutable(this.values.get(frame.sid), frame.ops));
			}
			for (const listener of this.#listeners) listener();
		});
	}
	/** `build`: what the page says in its first frame (null: no build); the default is a test hub's own stamp. */
	static open(port: number, origin: string | undefined = `http://127.0.0.1:${port}`, cookie?: string, build: string | null = stamp().id): Promise<Browser> {
		return new Promise((resolve, reject) => {
			const headers: Record<string, string> = {};
			if (origin !== undefined) headers.origin = origin;
			if (cookie !== undefined) headers.cookie = cookie;
			const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
			ws.once("open", () => {
				ws.send(JSON.stringify({ t: "hello", ...(build === null ? {} : { build }) }));
				resolve(new Browser(ws));
			});
			ws.once("error", reject);
			ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
		});
	}
	req(host: string, op: string, args: unknown = {}): Promise<any> {
		const id = this.#id++;
		return new Promise((resolve, reject) => {
			this.#waiters.set(id, (frame) => (frame.ok ? resolve(frame.value) : reject(Object.assign(new Error(frame.error.message), frame.error))));
			this.ws.send(JSON.stringify({ t: "req", id, host, op, args }));
		});
	}
	/** An op the hub serves itself (HubOps). */
	hub(op: string, args: unknown = {}): Promise<any> {
		const id = this.#id++;
		return new Promise((resolve, reject) => {
			this.#waiters.set(id, (frame) => (frame.ok ? resolve(frame.value) : reject(Object.assign(new Error(frame.error.message), frame.error))));
			this.ws.send(JSON.stringify({ t: "hub", id, op, args }));
		});
	}
	sub(host: string, topic: unknown, sid = this.#id++): number {
		this.ws.send(JSON.stringify({ t: "sub", sid, host, topic }));
		return sid;
	}
	/** Resolves when `predicate` holds over this browser's state (hosts, stale set, values). */
	when(predicate: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
		return new Promise((resolve, reject) => {
			const check = () => {
				if (predicate()) {
					this.#listeners.delete(check);
					clearTimeout(timer);
					resolve();
				}
			};
			const timer = setTimeout(() => {
				this.#listeners.delete(check);
				reject(new Error(`timeout waiting for ${what}; hosts: ${JSON.stringify(this.hosts.map((h) => [h.id, h.status, h.error]))}`));
			}, timeoutMs);
			this.#listeners.add(check);
			check();
		});
	}
	until<T = any>(sid: number, predicate: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
		// Made here, so a timeout's stack names the waiting line, not the timer.
		const failure = new Error("timeout");
		return new Promise((resolve, reject) => {
			const check = () => {
				const value = this.values.get(sid) as T | undefined;
				if (value !== undefined && predicate(value)) {
					this.#listeners.delete(check);
					clearTimeout(timer);
					resolve(value);
				}
			};
			const timer = setTimeout(() => {
				this.#listeners.delete(check);
				failure.message = `timeout: ${JSON.stringify(this.values.get(sid))?.slice(0, 500)}`;
				reject(failure);
			}, timeoutMs);
			this.#listeners.add(check);
			check();
		});
	}
}

