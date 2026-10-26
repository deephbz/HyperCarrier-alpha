import "./isolate.ts";
import { mkdtempSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyImmutable } from "@earendil-works/chord/delta";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import WebSocket from "ws";
import { simProvider } from "../src/node/sim.ts";
import { encodeFrame, lineReader } from "../src/shared/framing.ts";
import type { NodeFrame, Topic } from "../src/shared/protocol.ts";

export function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "ampi-test-"));
}

/**
 * A sim provider that holds the next summary request after `arm()`. A cooperative hold ends on its abort signal; an
 * uncooperative one ignores it. `release(n)` lets the n-th held request (1-based) answer as the sim does.
 */
export function heldSummaries(contextWindow?: number) {
	const models = createModels(), sim = simProvider({ tokensPerSecond: 1e9, ...(contextWindow ? { contextWindow } : {}) });
	const releases: (() => void)[] = [];
	let armed: "cooperative" | "uncooperative" | undefined;
	const state = {
		held: 0,
		aborted: 0,
		arm(mode: "cooperative" | "uncooperative" = "cooperative") { armed = mode; },
		release(n: number) { releases[n - 1]?.(); },
		releaseAll() { for (const release of releases) release(); },
	};
	models.setProvider({ ...sim, streamSimple(model, context, options) {
		const system = context.messages.find((message) => message.role === "system");
		const text = typeof system?.content === "string" ? system.content : system?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
		if (!armed || !/summariz/i.test(text)) return sim.streamSimple(model, context, options);
		const mode = armed;
		armed = undefined;
		state.held++;
		const stream = createAssistantMessageEventStream();
		let ended = false;
		releases.push(() => {
			if (ended) return;
			ended = true;
			void (async () => { for await (const event of sim.streamSimple(model, context, options)) stream.push(event); })();
		});
		const abort = () => {
			if (ended || mode === "uncooperative") return;
			ended = true;
			state.aborted++;
			stream.push({ type: "error", reason: "aborted", error: fauxAssistantMessage("compaction aborted", { stopReason: "aborted" }) });
		};
		if (options?.signal?.aborted) abort();
		else options?.signal?.addEventListener("abort", abort, { once: true });
		return stream;
	} });
	return { models, state };
}

/** A minimal ampi/1 client over the unix socket, for tests. */
export class TestClient {
	socket!: Socket;
	hello?: Extract<NodeFrame, { t: "hello" }>;
	#id = 1;
	#waiters = new Map<number, (frame: NodeFrame) => void>();
	values = new Map<number, unknown>();
	seq = new Map<number, number>();
	gaps: string[] = [];
	/** Every frame after `hello`, encoded as received: canary scans read it. */
	lines: string[] = [];
	/** The `end` reason of each closed subscription. */
	ended = new Map<number, string>();
	#listeners = new Set<() => void>();

	static async connect(path: string): Promise<TestClient> {
		const client = new TestClient();
		await new Promise<void>((resolve, reject) => {
			client.socket = createConnection(path, () => resolve());
			client.socket.once("error", reject);
		});
		const helloSeen = new Promise<void>((resolve) => {
			client.socket.on(
				"data",
				lineReader((line) => {
					const frame = JSON.parse(line) as NodeFrame;
					if (frame.t !== "hello") client.lines.push(line);
					if (frame.t === "end") client.ended.set(frame.sid, frame.reason);
					if (frame.t === "hello") {
						client.hello = frame;
						resolve();
					} else if (frame.t === "res") {
						// A settled waiter would keep its response alive for the client's lifetime.
						const waiter = client.#waiters.get(frame.id);
						client.#waiters.delete(frame.id);
						waiter?.(frame);
					}
					else if (frame.t === "snap") {
						client.values.set(frame.sid, frame.value);
						client.seq.set(frame.sid, 0);
					} else if (frame.t === "ops") {
						const expected = (client.seq.get(frame.sid) ?? 0) + 1;
						if (frame.n !== expected) client.gaps.push(`sid ${frame.sid}: got ops ${frame.n}, expected ${expected}`);
						client.seq.set(frame.sid, frame.n);
						client.values.set(frame.sid, applyImmutable(client.values.get(frame.sid), frame.ops as never));
					}
					for (const listener of client.#listeners) listener();
				}),
			);
		});
		await helloSeen;
		return client;
	}

	async req<T = any>(op: string, args: unknown = {}): Promise<T> {
		const id = this.#id++;
		const result = new Promise<NodeFrame>((resolve) => this.#waiters.set(id, resolve));
		this.socket.write(encodeFrame({ t: "req", id, op, args }));
		const frame = (await result) as Extract<NodeFrame, { t: "res" }>;
		if (!frame.ok) throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
		return frame.value as T;
	}

	sub(topic: Topic): number {
		const sid = this.#id++;
		this.socket.write(encodeFrame({ t: "sub", sid, topic }));
		return sid;
	}

	/** Resolves when `predicate` holds for the subscription value. */
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
				const last = JSON.stringify(this.values.get(sid)) ?? "";
				failure.message = `timeout; last value: ${last.length > 3000 ? `${last.slice(0, 800)} … ${last.slice(-2200)}` : last}`;
				reject(failure);
			}, timeoutMs);
			this.#listeners.add(check);
			check();
		});
	}

	close(): void {
		this.socket.destroy();
	}
}

/** A minimal browser-side replica client over the hub WebSocket, checking ops continuity like the web client. */
export class Browser {
	values = new Map<number, unknown>();
	seq = new Map<number, number>();
	gaps: string[] = [];
	snaps = new Map<number, number>();
	hosts: any[] = [];
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
			else if (frame.t === "hosts") this.hosts = frame.hosts;
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
	static open(port: number, origin: string | undefined = `http://127.0.0.1:${port}`, cookie?: string): Promise<Browser> {
		return new Promise((resolve, reject) => {
			const headers: Record<string, string> = {};
			if (origin !== undefined) headers.origin = origin;
			if (cookie !== undefined) headers.cookie = cookie;
			const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
			ws.once("open", () => resolve(new Browser(ws)));
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

