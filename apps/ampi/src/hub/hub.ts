// The AmPi hub: runs on the owner's desktop, keeps one link per Pi Host, serves the web UI, and multiplexes browser
// WebSockets onto host links. It owns no agent state: requests go to exactly the host they name, and subscriptions
// are re-established after a host reconnects (the Host sends a fresh snapshot).

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { basename, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { type BrowserFrame, type HostsFrame, type HubOps, type PiHostFrame, type PinsFrame, type SkippedHost, type Topic, isPiThreadId } from "../shared/protocol.ts";
import { linkKey } from "./hosts.ts";
import type { HostState } from "../shared/hosts.ts";
import { type HubHome, newHubToken } from "./home.ts";
import { Pins } from "./pins.ts";
import { READ_OPS, skewText, type Stamp, stamp, VERSION_SKEW } from "../shared/build.ts";
import { CONTROL_PROTOCOL, PiHost, type PiHostConfig } from "../pi/host.ts";
import type { Stamp as ArcStamp } from "../arc/service/engine.ts";
import { serviceTarget } from "../arc/service/client.ts";
import { deriveQueue } from "../pi/derive-queue.ts";
import { sweepAskScratch } from "../pi/ask.ts";
import { complete, instant, nowUs, span, tracing } from "../trace.ts";
import { loopWindow, watched } from "../loop-watch.ts";
import { type HelperModels, hubConfigPath, updateHubHosts, useHubConfig } from "./helper-models.ts";

export { hubConfigPath };

// `models` names helper models; helper-models.ts reads them from the file on every call and owns every hub.json write.
/**
 * `persistentCookie`: the login cookie outlives the client session (see `loginCookie`). `skipped`: hub.json Host rows
 * this hub does not serve (durable `local` and `ssh` Hosts); the window names them once.
 */
type HubConfig = { hosts: PiHostConfig[]; skipped?: SkippedHost[]; self?: string; models?: HelperModels; persistentCookie?: boolean };

const isPiConfig = (host: { kind?: unknown }): host is PiHostConfig => host.kind === "pi-local" || host.kind === "pi-ssh";

/** `host` is the link key the subscription resolved to. */
type BrowserSub = { sid: number; host: string; topic: Topic; hostSid?: number };

const WEB_DIST = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".json": "application/json",
};

/** Browsers send cookies to every port of a host, so the cookie names its port: no other loopback server receives it. */
function cookieName(port: number): string {
	return `ampi_k_${port}`;
}

/**
 * The login cookie. Cookies ignore the port, so a client collects one per hub port it ever signed in to. Only a hub that
 * opts in (`persistentCookie`: the owner's long-lived hub) leaves a year-long cookie; every other hub's cookie ends with
 * the client session. The expiring form matches it attribute for attribute, or the client keeps the old one.
 */
function loginCookie(port: number, value: string, persistent: boolean): string {
	return `${cookieName(port)}=${value}; HttpOnly; SameSite=Strict; Path=/${persistent ? "; Max-Age=31536000" : ""}`;
}
const expiredCookie = (name: string) => `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

/**
 * Above this many `ampi_k_*` cookies in one request the hub expires the other ports' cookies. At about 79 bytes each,
 * Node's default 16 KiB header limit broke at about 205 (431 before the hub saw the request). A person with a few
 * long-lived hubs stays far below 32, so their other hubs stay signed in; a client that collected disposable hubs'
 * cookies heals on its next request, long before the 64 KiB limit below (about 800).
 */
const STALE_COOKIE_LIMIT = 32;
/** The HTTP header limit: it must leave room for a piled-up client to reach the heal above. */
const MAX_HEADER_BYTES = 64 * 1024;
/** The backstop: a client past MAX_HEADER_BYTES never reaches the hub's code, so the parser's refusal must say what to do. */
const HEADER_OVERFLOW_PAGE = `<!doctype html><meta charset="utf-8"><title>AmPi: too many cookies</title><body style="font: 14px -apple-system, sans-serif; max-width: 640px; margin: 15vh auto">
<h2>AmPi cannot read this request: too many AmPi cookies for 127.0.0.1</h2>
<p>Each AmPi hub you signed in to left a cookie, and together they are too large to send.</p>
<p>In a browser, clear the cookies for 127.0.0.1, then run <code>ampi open</code> for a fresh link.</p>
<p>AmPi.app on macOS: quit it and remove its website data: <code>rm ~/Library/HTTPStorages/dev.hypercarrier.ampi.binarycookies</code>, then open it again. Or use a browser tab via <code>ampi open</code>.</p></body>`;

/** What the hub shows unauthenticated callers to prove it holds the key, without revealing it. */
export function hubProof(token: string): string {
	return createHash("sha256").update(`ampi-hub:${token}`).digest("hex").slice(0, 32);
}
/**
 * The `/api/health` body. An unauthenticated caller gets only `ok` and `proof`. An authorized one also gets the hub's
 * build `stamp` and, per Host link, the pi-hc-control build it sees: the first live control that is unstamped (null)
 * or of another build, else the expected one; null without a live control. `runningControls` counts the controls that run on any
 * protocol, so 0 tells that null from an unstamped control. `controlProtocol` names the protocol this hub speaks and,
 * per Host, the first running control's protocol that differs from it, else the hub's; null with no running control. `arcTarget` names the shipped Arc bundle;
 * null until its build succeeds. Each Host reports its running `arcStamp`. The route below builds exactly this shape.
 */
export type HealthBody =
	| { ok: true; proof: string }
	| {
			ok: true;
			proof: string;
			stamp: Stamp;
			controlProtocol: string;
			arcTarget: ArcStamp | null;
			hosts: (HostState & { controlStamp: Stamp | null; runningControls: number; controlProtocol: string | null; arcStamp: ArcStamp | null })[];
			derive: ReturnType<typeof deriveQueue>;
			builds: { pending: number; done: number };
			loop: ReturnType<typeof loopWindow> | null;
			missedInputs: number;
	  };
const MAX_BUFFERED = 32 * 1024 * 1024;

function same(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The hub's Hosts (D15). This machine is always a Pi Host named by its own Host ID (`self`, else AMPI_SELF, else this
 * machine's `hostname`). hub.json lists every other Host. A `local` or `ssh` row names a durable node, which only the
 * durable release serves: the hub skips it, keeps it in hub.json, and reports it in `skipped`.
 */
export function loadHubConfig(path = hubConfigPath()): HubConfig & { self: string } {
	const parsed = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<Omit<HubConfig, "hosts">> & { hosts?: { id: string; label?: string; kind?: string }[] }) : {};
	const rows = parsed.hosts ?? [];
	const hosts = rows.filter(isPiConfig);
	const skipped = rows.filter((host) => !isPiConfig(host)).map((host) => ({ id: host.id, label: host.label ?? host.id, kind: String(host.kind) }));
	const models = { ...(parsed.models ? { models: parsed.models } : {}), ...(parsed.persistentCookie === true ? { persistentCookie: true } : {}) };
	// Every Session reference names its Host, so this machine always has a real name, never a placeholder.
	const self = parsed.self ?? process.env.AMPI_SELF ?? hostname();
	if (!hosts.some((host) => host.kind === "pi-local")) hosts.unshift({ id: self, label: self, kind: "pi-local" });
	return { hosts, self, ...(skipped.length ? { skipped } : {}), ...models };
}

class BrowserClient {
	readonly ws: WebSocket;
	readonly hub: Hub;
	readonly subs = new Map<number, BrowserSub>();
	/** The build the page says it is (its `hello` frame); undefined until it says. */
	build: string | undefined;
	/** Requests in flight per host: host request id → browser request id. */
	readonly pending = new Map<string, Map<number, number>>();

	constructor(hub: Hub, ws: WebSocket) {
		this.hub = hub;
		this.ws = ws;
	}

	send(frame: unknown): void {
		if (this.ws.readyState !== this.ws.OPEN) return;
		// A window that stops reading (asleep, frozen) must not grow the hub without bound: drop it; on its next
		// connection it resubscribes from snapshots.
		if (this.ws.bufferedAmount > MAX_BUFFERED) {
			this.ws.terminate();
			return;
		}
		if (!tracing) {
			this.ws.send(JSON.stringify(frame));
			return;
		}
		const start = nowUs();
		const text = JSON.stringify(frame);
		this.ws.send(text);
		const t = (frame as { t?: string }).t;
		complete("ws-send", "ws", start, { t, bytes: text.length });
		if (t === "snap") this.hub.milestone("first-snapshot");
	}
}

export class Hub {
	readonly links = new Map<string, PiHost>();
	readonly clients = new Set<BrowserClient>();
	readonly config: HubConfig;
	readonly configPath: string | undefined;
	readonly pins: Pins;
	/** This hub's build. Its version goes into the served page and every hosts frame; a page of another build only reads. */
	readonly stamp: Stamp;
	server?: Server;
	#nextHostId = 1;
	/** host sid → owner, per host. */
	#hostSubs = new Map<string, Map<number, { client: BrowserClient; sid: number }>>();
	#hostReqs = new Map<string, Map<number, { client: BrowserClient; id: number }>>();

	readonly token: string;
	port = 0;
	#milestones = new Set<string>();

	readonly persistentCookie: boolean;
	#home: HubHome | undefined;
	#healLogged = new Map<string, number>();

	/**
	 * `home`: the AmPi home this hub owns, where its pins, key and Pi copies persist. Without it (demo and test hubs)
	 * pins last as long as this hub, the key is `token` or a new one, and every Pi Host names its own `cacheDir`.
	 * `stamp`: this hub's build for tests; the default is the checkout's (build.ts stamp()).
	 */
	constructor(config: HubConfig, options: { configPath?: string; token?: string; persistentCookie?: boolean; home?: HubHome; stamp?: Stamp } = {}) {
		this.config = config;
		this.stamp = options.stamp ?? stamp();
		this.#home = options.home;
		this.pins = new Pins(options.home);
		this.persistentCookie = options.persistentCookie ?? config.persistentCookie === true;
		this.configPath = options.configPath;
		useHubConfig(options.configPath, config.models);
		this.token = options.token ?? options.home?.token() ?? newHubToken();
		for (const host of config.hosts) this.#addLink(host);
	}

	/** A trace instant the first time this hub reaches the named point. */
	milestone(name: string): void {
		if (!tracing || this.#milestones.has(name)) return;
		this.#milestones.add(name);
		instant(name);
	}

	/**
	 * A Pi Host keeps its copies in the home's pi-cache, which the home holds, unless its config names a `cacheDir`.
	 * The hub locks that exact directory before the Host reads it, and throws RootOwned when another hub owns it.
	 */
	#piCache(config: PiHostConfig): PiHostConfig & { cacheDir: string } {
		if (config.cacheDir) return { ...config, cacheDir: this.#home?.claim(config.cacheDir, `Pi Host ${config.id}'s copies`) ?? config.cacheDir };
		if (!this.#home) throw new Error(`Pi Host ${config.id}: a hub without a home needs a cacheDir for it`);
		return { ...config, cacheDir: this.#home.file("pi-cache") };
	}

	#addLink(config: PiHostConfig): PiHost {
		const link = new PiHost(this.#piCache(config));
		const key = linkKey(config);
		this.links.set(key, link);
		this.#hostSubs.set(key, new Map());
		this.#hostReqs.set(key, new Map());
		link.on("state", () => this.#broadcastHosts());
		link.on("frame", (frame: PiHostFrame) => this.#fromHost(key, frame));
		link.on("connected", () => this.#resubscribe(key));
		link.on("disconnected", () => this.#failPending(key));
		return link;
	}

	/**
	 * The link key a browser frame names: a link key (`<id>#pi`) or a Host ID. Only a Pi thread ID (`pi:…`) resolves; a
	 * durable thread ID, as an old pin names, has no source on this hub.
	 */
	route(host: string, thread?: string): { key: string } | { error: { code: string; message: string } } {
		if (this.links.has(host)) return { key: host };
		const key = linkKey({ id: host });
		if (!this.links.has(key)) return { error: { code: "host_unavailable", message: `Host ${host} is unknown` } };
		if (thread !== undefined && !isPiThreadId(thread)) return { error: { code: "source_unavailable", message: `Host ${host} serves Pi Sessions only; thread ${thread} needs the durable release` } };
		return { key };
	}

	/** The link a Host ID or link key names, if exactly one. */
	link(host: string): PiHost | undefined {
		const route = this.route(host);
		return "key" in route ? this.links.get(route.key) : undefined;
	}

	hostStates(): (HostState & { arcStamp: import("../arc/service/engine.ts").Stamp | null })[] {
		return [...this.links].map(([key, link]) => ({ ...link.state, link: key, arcStamp: link.arcStamp }));
	}

	#hostsFrame(): HostsFrame {
		return { t: "hosts", build: this.stamp.id, hosts: this.hostStates(), ...(this.configPath ? { config: this.configPath } : {}), ...(this.config.skipped?.length ? { skipped: this.config.skipped } : {}) };
	}

	#broadcastHosts(): void {
		const frame = this.#hostsFrame();
		for (const client of this.clients) client.send(frame);
	}

	#fromHost(hostId: string, frame: PiHostFrame): void {
		if (frame.t === "res") {
			const owner = this.#hostReqs.get(hostId)?.get(frame.id);
			if (!owner) return;
			this.#hostReqs.get(hostId)!.delete(frame.id);
			owner.client.send({ ...frame, id: owner.id });
			return;
		}
		if (frame.t === "snap" || frame.t === "ops" || frame.t === "end" || frame.t === "pending") {
			const owner = this.#hostSubs.get(hostId)?.get(frame.sid);
			if (!owner) return;
			if (frame.t === "end") this.#hostSubs.get(hostId)!.delete(frame.sid);
			owner.client.send({ ...frame, sid: owner.sid });
		}
	}

	#failPending(hostId: string): void {
		const reqs = this.#hostReqs.get(hostId)!;
		for (const { client, id } of reqs.values())
			client.send({ t: "res", id, ok: false, error: { code: "host_disconnected", message: `${hostId} disconnected` } });
		reqs.clear();
		// Subscriptions stay registered; they resubscribe on reconnect and get a fresh snapshot.
		for (const { client, sid } of this.#hostSubs.get(hostId)!.values()) client.send({ t: "stale", sid });
	}

	#resubscribe(hostId: string): void {
		const link = this.links.get(hostId)!;
		const subs = this.#hostSubs.get(hostId)!;
		const owners = [...subs.values()];
		subs.clear();
		for (const { client, sid } of owners) {
			const sub = client.subs.get(sid);
			if (!sub) continue;
			const hostSid = this.#nextHostId++;
			sub.hostSid = hostSid;
			subs.set(hostSid, { client, sid });
			link.send({ t: "sub", sid: hostSid, topic: sub.topic });
		}
	}

	#fromBrowser(client: BrowserClient, frame: BrowserFrame): void {
		if (frame.t === "hello") {
			client.build = typeof frame.build === "string" ? frame.build : undefined;
			return;
		}
		// A page of another build reads, and nothing it sends changes state (P1). A page that never said its build is
		// another build: the hub fails closed.
		if ((frame.t === "hub" || (frame.t === "req" && !READ_OPS.has(frame.op))) && client.build !== this.stamp.id) {
			client.send({ t: "res", id: frame.id, ok: false, error: { code: VERSION_SKEW, message: skewText.page, skew: "page" } });
			return;
		}
		if (frame.t === "hub") {
			void this.#hubOp(client, frame.id, frame.op, frame.args ?? {});
			return;
		}
		if (frame.t === "unsub") {
			const sub = client.subs.get(frame.sid);
			if (!sub) return;
			client.subs.delete(frame.sid);
			if (sub.hostSid !== undefined) {
				this.#hostSubs.get(sub.host)?.delete(sub.hostSid);
				this.links.get(sub.host)?.send({ t: "unsub", sid: sub.hostSid });
			}
			return;
		}
		const thread = (frame.t === "req" ? (frame.args as { threadId?: unknown } | undefined) : (frame.topic as { threadId?: unknown }))?.threadId;
		const route = this.route(frame.host, typeof thread === "string" ? thread : undefined);
		const key = "key" in route ? route.key : undefined;
		const link = key === undefined ? undefined : this.links.get(key);
		if (frame.t === "req") {
			// A Pi Host answers from its local copies even while the Host is away; it refuses actions itself.
			if (!link || key === undefined) {
				client.send({
					t: "res",
					id: frame.id,
					ok: false,
					error: "error" in route ? route.error : { code: "host_unavailable", message: `Host ${frame.host} is ${link?.state.status ?? "unknown"}` },
				});
				return;
			}
			const hostId = this.#nextHostId++;
			this.#hostReqs.get(key)!.set(hostId, { client, id: frame.id });
			link.send({ t: "req", id: hostId, op: frame.op, args: frame.args });
			return;
		}
		if (frame.t === "sub") {
			// The page shows an end reason as its state: an unknown Host reads "Unknown host <id>", as before link keys.
			if (!link || key === undefined) {
				client.send({ t: "end", sid: frame.sid, reason: "error" in route && route.error.code !== "host_unavailable" ? route.error.message : `Unknown host ${frame.host}` });
				return;
			}
			// A repeated sub for the same browser sid replaces the earlier one, so two Host streams never feed one replica.
			const prior = client.subs.get(frame.sid);
			if (prior?.hostSid !== undefined) {
				this.#hostSubs.get(prior.host)?.delete(prior.hostSid);
				this.links.get(prior.host)?.send({ t: "unsub", sid: prior.hostSid });
			}
			const sub: BrowserSub = { sid: frame.sid, host: key, topic: frame.topic };
			client.subs.set(frame.sid, sub);
			const hostSid = this.#nextHostId++;
			sub.hostSid = hostSid;
			this.#hostSubs.get(key)!.set(hostSid, { client, sid: frame.sid });
			if (!link.send({ t: "sub", sid: hostSid, topic: frame.topic })) client.send({ t: "stale", sid: frame.sid });
		}
	}

	async #hubOp(client: BrowserClient, id: number, op: string, args: Record<string, unknown>): Promise<void> {
		try {
			let value: HubOps[keyof HubOps]["result"];
			switch (op) {
				case "hosts.remove": {
					const route = this.route(String(args.id));
					if ("error" in route) throw new Error(route.error.message);
					const hostId = route.key;
					const link = this.links.get(hostId);
					if (!link || link.config.kind === "pi-local") throw new Error("Cannot remove this host");
					// The file changes first: a refused write leaves the Host connected and listed. Skipped rows stay.
					if (this.configPath) updateHubHosts<{ id: string; kind?: string }>(this.configPath, (hosts) => hosts.filter((h) => !(isPiConfig(h) && linkKey(h) === hostId)));
					await link.stop();
					this.links.delete(hostId);
					// Fail what was in flight and end open views instead of leaving them pending forever.
					this.#failPending(hostId);
					for (const { client, sid } of this.#hostSubs.get(hostId)?.values() ?? []) client.send({ t: "end", sid, reason: "host removed" });
					this.#hostSubs.delete(hostId);
					this.#hostReqs.delete(hostId);
					this.config.hosts.splice(this.config.hosts.findIndex((h) => linkKey(h) === hostId), 1);
					value = {} satisfies HubOps["hosts.remove"]["result"];
					break;
				}
				case "hosts.reconnect":
					this.link(String(args.id))?.reconnect();
					value = {} satisfies HubOps["hosts.reconnect"]["result"];
					break;
				case "pins.set": {
					const threadId = String(args.threadId ?? "");
					if (!threadId) throw new Error("A pin needs a threadId");
					const pins = this.pins.set(threadId, args.pinned === true, String(args.host ?? ""), String(args.title ?? "").slice(0, 200));
					for (const each of this.clients) each.send({ t: "pins", pins } satisfies PinsFrame);
					client.send({ t: "res", id, ok: true, value: {} satisfies HubOps["pins.set"]["result"] });
					return;
				}
				case "pins.hint": {
					const pins = this.pins.hint(String(args.host ?? ""), String(args.threadId ?? ""));
					if (pins) for (const each of this.clients) each.send({ t: "pins", pins } satisfies PinsFrame);
					client.send({ t: "res", id, ok: true, value: {} satisfies HubOps["pins.hint"]["result"] });
					return;
				}
				default:
					throw new Error(`Unknown hub operation ${op}`);
			}
			client.send({ t: "res", id, ok: true, value });
			this.#broadcastHosts();
		} catch (error) {
			client.send({ t: "res", id, ok: false, error: { code: "hub", message: (error as Error).message } });
		}
	}

	#detach(client: BrowserClient): void {
		this.clients.delete(client);
		for (const sub of client.subs.values()) {
			if (sub.hostSid === undefined) continue;
			this.#hostSubs.get(sub.host)?.delete(sub.hostSid);
			this.links.get(sub.host)?.send({ t: "unsub", sid: sub.hostSid });
		}
		for (const reqs of this.#hostReqs.values()) for (const [key, owner] of reqs) if (owner.client === client) reqs.delete(key);
	}

	async listen(port: number, host = "127.0.0.1"): Promise<number> {
		const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => this.#http(req, res, port));
		server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
			// Only header overflow gets the explanation; every other parse error keeps Node's default answer.
			if (error.code !== "HPE_HEADER_OVERFLOW") return void socket.destroy(error);
			if (!socket.writable) return void socket.destroy();
			socket.end(`HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(HEADER_OVERFLOW_PAGE)}\r\nConnection: close\r\n\r\n${HEADER_OVERFLOW_PAGE}`);
		});
		const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
		server.on("upgrade", (req, socket, head) => {
			if (!this.#trusted(req) || !this.#authorized(req) || !req.url?.startsWith("/ws")) {
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				const client = new BrowserClient(this, ws);
				this.clients.add(client);
				this.milestone("first-ws-connect");
				client.send(this.#hostsFrame());
				client.send({ t: "pins", pins: this.pins.list() } satisfies PinsFrame);
				ws.on("message", (data) => {
					const start = tracing ? nowUs() : 0;
					let frame: BrowserFrame | undefined;
					try {
						frame = JSON.parse(String(data)) as BrowserFrame;
						const f = frame;
						watched(() => `browser frame ${f.t}${"op" in f ? ` ${f.op}` : f.t === "sub" ? ` ${f.topic.kind === "view" ? f.topic.view : f.topic.kind}` : ""}`, () => this.#fromBrowser(client, f));
					} catch {}
					if (tracing) {
						this.milestone("first-ws-frame");
						const topic = frame?.t === "sub" ? frame.topic : undefined;
						complete("ws-message", "ws", start, { t: frame?.t, op: frame && "op" in frame ? frame.op : topic?.kind, bytes: (data as Buffer).length });
					}
				});
				ws.on("close", () => this.#detach(client));
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, host, () => resolve());
		});
		// Model-call prompt files an earlier hub left behind (a crash skips their cleanup).
		sweepAskScratch();
		this.server = server;
		const address = server.address();
		this.port = typeof address === "object" && address ? address.port : port;
		instant("listen", { port: this.port });
		span("links-start", "startup", () => { for (const link of this.links.values()) link.start(); });
		return this.port;
	}

	/** Loopback-only: refuse cross-site pages and DNS-rebinding hosts (the hub can run commands on every host). */
	/**
	 * Only the hub's own page may drive it: the Host must be loopback (DNS rebinding), and a browser Origin must be
	 * this very host and port, so another local page or dev server cannot reach the hub's operations.
	 */
	#trusted(req: IncomingMessage): boolean {
		const hostHeader = req.headers.host ?? "";
		const host = hostHeader.replace(/:\d+$/, "");
		if (!["127.0.0.1", "localhost", "[::1]"].includes(host) && process.env.AMPI_HUB_ALLOW_HOST !== host) return false;
		const origin = req.headers.origin;
		if (origin === undefined) return true;
		if ((process.env.AMPI_HUB_ALLOW_ORIGIN ?? "").split(",").includes(origin)) return true;
		try {
			return new URL(origin).host === hostHeader;
		} catch {
			return false;
		}
	}

	/** The key arrives once in the URL (`?k=`), then lives in an HttpOnly, SameSite=Strict cookie; tools may send a bearer header. */
	#authorized(req: IncomingMessage): boolean {
		const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
		if (bearer !== undefined) return same(bearer, this.token);
		for (const part of (req.headers.cookie ?? "").split(";")) {
			const [name, ...value] = part.trim().split("=");
			if (name === cookieName(this.port) && same(value.join("="), this.token)) return true;
		}
		return false;
	}

	#http(req: IncomingMessage, res: ServerResponse, port: number): void {
		if (!tracing) return this.#serve(req, res, port);
		const start = nowUs();
		this.#serve(req, res, port);
		// The path only: the query can carry the access key.
		const path = (req.url ?? "/").split("?")[0]!;
		const health = path === "/api/health";
		complete(health ? "GET /api/health" : "GET static", "http", start, { status: res.statusCode, ...(health ? {} : { path: path.slice(0, 80) }) });
		if (health && res.statusCode === 200) this.milestone("health-ok");
	}

	/** Expiring Set-Cookie headers for the other ports' hub cookies, when a request carries a pile-up of them. */
	#staleCookies(req: IncomingMessage): string[] {
		const names = (req.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")[0]!).filter((name) => /^ampi_k_\d+$/.test(name));
		if (names.length <= STALE_COOKIE_LIMIT) return [];
		const stale = [...new Set(names)].filter((name) => name !== cookieName(this.port));
		// One line per user agent per minute: a client heals on its next response, but parallel requests can repeat.
		const agent = String(req.headers["user-agent"] ?? "no user agent").slice(0, 120), now = Date.now();
		if ((this.#healLogged.get(agent) ?? 0) + 60_000 <= now) {
			this.#healLogged.set(agent, now);
			console.log(`hub: expired ${stale.length} stale ampi_k_* cookies from a client (${agent})`);
		}
		return stale.map(expiredCookie);
	}

	#serve(req: IncomingMessage, res: ServerResponse, _port: number): void {
		const stale = this.#staleCookies(req);
		if (stale.length) res.setHeader("set-cookie", stale);
		if (!this.#trusted(req)) {
			res.writeHead(403).end("forbidden");
			return;
		}
		const url = new URL(req.url ?? "/", "http://localhost");
		const key = url.searchParams.get("k");
		if (key !== null) {
			url.searchParams.delete("k");
			const location = `${url.pathname}${url.search}`;
			if (!same(key, this.token)) {
				res.writeHead(403, { "content-type": "text/plain" }).end("This AmPi access key is not valid. Run `ampi open` for the current link.");
				return;
			}
			res.writeHead(303, { location, "set-cookie": [...stale, loginCookie(this.port, this.token, this.persistentCookie)] }).end();
			return;
		}
		if (url.pathname === "/api/health") {
			// Unauthenticated callers learn only that this hub answers and a proof that it holds the key, so the app hands
			// the key only to the real hub, never to another process that took the port.
			const body: HealthBody = this.#authorized(req) ? { ok: true, proof: hubProof(this.token), stamp: this.stamp, controlProtocol: CONTROL_PROTOCOL, arcTarget: serviceTarget(), hosts: [...this.links].map(([key, link]) => ({ ...link.state, link: key, arcStamp: link.arcStamp, controlStamp: link.controlStamp, runningControls: link.runningControls, controlProtocol: link.controlProtocol })), derive: deriveQueue(), builds: [...this.links.values()].reduce((sum, link) => { const q = link instanceof PiHost ? link.arcQueue : { pending: 0, done: 0 }; return { pending: sum.pending + q.pending, done: sum.done + q.done }; }, { pending: 0, done: 0 }), loop: loopWindow() ?? null, missedInputs: [...this.links.values()].reduce((n, l) => n + (l instanceof PiHost ? l.missedInputs : 0), 0) } : { ok: true, proof: hubProof(this.token) };
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
			return;
		}
		let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
		if (path === "/" || !extname(path)) path = "/index.html";
		const file = join(WEB_DIST, path);
		// Dotfiles in web/dist are build records (.web-inputs.json lists machine paths), not part of the bundle.
		if (!file.startsWith(WEB_DIST) || basename(file).startsWith(".") || !existsSync(file) || !statSync(file).isFile()) {
			res.writeHead(404).end("not found (did you run npm run build:web?)");
			return;
		}
		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			"cache-control": path === "/index.html" ? "no-cache" : "public, max-age=31536000, immutable",
		});
		// The page learns its build from the hub that served it and says it in its first frame (web/src/client.ts).
		if (path === "/index.html") res.end(String(readFileSync(file)).replace("</head>", `<meta name="ampi-build" content="${this.stamp.id}" />\n</head>`));
		else res.end(readFileSync(file));
	}

	async close(): Promise<void> {
		try {
			// Every link finishes stopping before the hub reports the first failure.
			const stops = await Promise.allSettled([...this.links.values()].map((link) => link.stop()));
			const failed = stops.find((stop) => stop.status === "rejected");
			if (failed) throw failed.reason;
		} finally {
			// Quit cannot wait for browser close handshakes or speculative TCP headers.
			for (const client of this.clients) client.ws.terminate();
			await new Promise<void>((resolve) => {
				if (!this.server) { resolve(); return; }
				this.server.close(() => resolve());
				this.server.closeAllConnections();
			});
		}
	}
}
