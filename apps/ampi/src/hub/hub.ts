// The AmPi hub: runs on the owner's desktop, keeps one link per host, serves the web UI, and multiplexes browser
// WebSockets onto host links. It owns no agent state: requests go to exactly the host they name, and subscriptions
// are re-established after a host reconnects (the node sends a fresh snapshot).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, hostname } from "node:os";
import { basename, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { HostsFrame, HubOps, NodeFrame, Topic } from "../shared/protocol.ts";
import { type HostConfig, HostLink, type HostState } from "./hosts.ts";
import { PiHost, type PiHostConfig } from "../pi/host.ts";
import { buildQueue, deriveQueue } from "../pi/derive-queue.ts";
import { sweepAskScratch } from "../pi/ask.ts";
import { complete, instant, nowUs, span, tracing } from "../trace.ts";
import { loopWindow, watched } from "../loop-watch.ts";
import { type ArcEvidence, type HelperModels, hubConfigPath, updateHubHosts, useHubConfig } from "./helper-models.ts";

export { hubConfigPath };

// `models` names helper models; helper-models.ts reads them from the file on every call and owns every hub.json write.
/** `persistentCookie`: the login cookie outlives the client session (see `loginCookie`). */
export type HubConfig = { hosts: (HostConfig | PiHostConfig)[]; backend?: "pi"; self?: string; models?: HelperModels; arcEvidence?: ArcEvidence; persistentCookie?: boolean };

/** Browser → hub frames: node frames addressed to one host, plus hub operations. */
type BrowserFrame =
	| { t: "req"; id: number; host: string; op: string; args?: unknown }
	| { t: "sub"; sid: number; host: string; topic: Topic }
	| { t: "unsub"; sid: number }
	| { t: "hub"; id: number; op: string; args?: Record<string, unknown> };

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

/**
 * The hub's access key: 32 random bytes in a 0600 file next to the node socket. The hub can type into terminals and
 * run agents on every host, so it trusts exactly who the node socket trusts (the owner's own processes), not every
 * process that can reach loopback.
 */
export function hubToken(home = process.env.AMPI_HOME ?? join(homedir(), ".ampi")): string {
	try {
		const token = readFileSync(join(home, "hub.token"), "utf8").trim();
		if (/^[0-9a-f]{64}$/.test(token)) return token;
	} catch {}
	return saveHubToken(home, newHubToken());
}

export function newHubToken(): string {
	return randomBytes(32).toString("hex");
}

/**
 * Replaces the stored key. The page, the app, and `ampi open` read the file each time, so they pick it up; a hub
 * keeps the key it started with, and browsers holding the old cookie must open the new link.
 */
export function saveHubToken(home: string, token: string): string {
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const path = join(home, "hub.token");
	// Write then rename: a reader never sees a partial key, and the file is 0600 from its first byte.
	const next = `${path}.${process.pid}.tmp`;
	writeFileSync(next, `${token}\n`, { mode: 0o600 });
	renameSync(next, path);
	return token;
}

/** Browsers send cookies to every port of a host, so the cookie names its port: no other loopback server receives it. */
export function cookieName(port: number): string {
	return `ampi_k_${port}`;
}

/**
 * The login cookie. Cookies ignore the port, so a client collects one per hub port it ever signed in to. Only a hub that
 * opts in (`persistentCookie`: the owner's long-lived hub) leaves a year-long cookie; every other hub's cookie ends with
 * the client session. The expiring form matches it attribute for attribute, or the client keeps the old one.
 */
export function loginCookie(port: number, value: string, persistent: boolean): string {
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
const MAX_BUFFERED = 32 * 1024 * 1024;

function same(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Pi backend (D15 stage 1): `"backend": "pi"` in hub.json, or AMPI_BACKEND=pi. This machine is a Pi Host named by its
 * own Host ID (`self`, default this machine's `hostname`), and no pi-durable node starts. Without it the hub keeps the AmPi node.
 */
export function loadHubConfig(path = hubConfigPath()): HubConfig {
	const parsed = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<HubConfig> & { backend?: string; self?: string }) : {};
	const hosts = parsed.hosts ?? [];
	const models = { ...(parsed.models ? { models: parsed.models } : {}), ...(parsed.persistentCookie === true ? { persistentCookie: true } : {}) };
	if ((parsed.backend ?? process.env.AMPI_BACKEND) === "pi") {
		// Every Session reference names its Host, so this machine always has a real name, never a placeholder.
		const self = parsed.self ?? process.env.AMPI_SELF ?? hostname();
		if (!hosts.some((host) => host.kind === "pi-local")) hosts.unshift({ id: self, label: self, kind: "pi-local" });
		return { hosts, backend: "pi", self, ...models };
	}
	if (!hosts.some((host) => host.kind === "local")) hosts.unshift({ id: "local", label: process.platform === "darwin" ? "This Mac" : "Local", kind: "local" });
	return { hosts, ...models };
}

class BrowserClient {
	readonly ws: WebSocket;
	readonly hub: Hub;
	readonly subs = new Map<number, BrowserSub>();
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
	readonly links = new Map<string, HostLink | PiHost>();
	readonly clients = new Set<BrowserClient>();
	readonly config: HubConfig;
	readonly configPath: string | undefined;
	server?: Server;
	#nextHostId = 1;
	/** host sid → owner, per host. */
	#hostSubs = new Map<string, Map<number, { client: BrowserClient; sid: number }>>();
	#hostReqs = new Map<string, Map<number, { client: BrowserClient; id: number }>>();

	readonly token: string;
	port = 0;
	#milestones = new Set<string>();

	readonly persistentCookie: boolean;
	#healLogged = new Map<string, number>();

	constructor(config: HubConfig, options: { configPath?: string; token?: string; persistentCookie?: boolean } = {}) {
		this.config = config;
		this.persistentCookie = options.persistentCookie ?? config.persistentCookie === true;
		this.configPath = options.configPath;
		useHubConfig(options.configPath, config.models, config.arcEvidence);
		this.token = options.token ?? hubToken();
		for (const host of config.hosts) this.#addLink(host);
	}

	/** A trace instant the first time this hub reaches the named point. */
	milestone(name: string): void {
		if (!tracing || this.#milestones.has(name)) return;
		this.#milestones.add(name);
		instant(name);
	}

	#addLink(config: HostConfig | PiHostConfig): HostLink | PiHost {
		const link = config.kind === "pi-local" || config.kind === "pi-ssh" ? new PiHost(config as PiHostConfig) : new HostLink(config as HostConfig);
		this.links.set(config.id, link);
		this.#hostSubs.set(config.id, new Map());
		this.#hostReqs.set(config.id, new Map());
		link.on("state", () => this.#broadcastHosts());
		link.on("frame", (frame: NodeFrame) => this.#fromHost(config.id, frame));
		link.on("connected", () => this.#resubscribe(config.id));
		link.on("disconnected", () => this.#failPending(config.id));
		return link;
	}

	hostStates(): HostState[] {
		return [...this.links.values()].map((link) => link.state);
	}

	#broadcastHosts(): void {
		const hosts = this.hostStates();
		for (const client of this.clients) client.send({ t: "hosts", hosts } satisfies HostsFrame);
	}

	#fromHost(hostId: string, frame: NodeFrame): void {
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
		const link = this.links.get(frame.host);
		if (frame.t === "req") {
			// A Pi Host answers from its local copies even while the Host is away; it refuses actions itself.
			if (!link || (link.state.status !== "connected" && !(link instanceof PiHost))) {
				client.send({
					t: "res",
					id: frame.id,
					ok: false,
					error: { code: "host_unavailable", message: `Host ${frame.host} is ${link?.state.status ?? "unknown"}` },
				});
				return;
			}
			const hostId = this.#nextHostId++;
			this.#hostReqs.get(frame.host)!.set(hostId, { client, id: frame.id });
			link.send({ t: "req", id: hostId, op: frame.op, args: frame.args });
			return;
		}
		if (frame.t === "sub") {
			if (!link) {
				client.send({ t: "end", sid: frame.sid, reason: `Unknown host ${frame.host}` });
				return;
			}
			// A repeated sub for the same browser sid replaces the earlier one, so two node streams never feed one replica.
			const prior = client.subs.get(frame.sid);
			if (prior?.hostSid !== undefined) {
				this.#hostSubs.get(prior.host)?.delete(prior.hostSid);
				this.links.get(prior.host)?.send({ t: "unsub", sid: prior.hostSid });
			}
			const sub: BrowserSub = { sid: frame.sid, host: frame.host, topic: frame.topic };
			client.subs.set(frame.sid, sub);
			const hostSid = this.#nextHostId++;
			sub.hostSid = hostSid;
			this.#hostSubs.get(frame.host)!.set(hostSid, { client, sid: frame.sid });
			if (!link.send({ t: "sub", sid: hostSid, topic: frame.topic })) client.send({ t: "stale", sid: frame.sid });
		}
	}

	async #hubOp(client: BrowserClient, id: number, op: string, args: Record<string, unknown>): Promise<void> {
		try {
			let value: HubOps[keyof HubOps]["result"];
			switch (op) {
				case "hosts.add": {
					const target = String(args.target ?? "").trim();
					if (!/^[A-Za-z0-9_.@:-]+$/.test(target)) throw new Error("Enter an ssh destination like me@devbox");
					if (this.config.backend === "pi") {
						// The SSH alias is the Host's identity (D15): one link per alias.
						if (this.links.has(target)) throw new Error(`${target} is already added`);
						const pi: PiHostConfig = { id: target, label: String(args.label || target), kind: "pi-ssh", target };
						if (this.configPath) updateHubHosts<HostConfig | PiHostConfig>(this.configPath, (hosts) => [...hosts, pi]);
						this.config.hosts.push(pi);
						this.#addLink(pi).start();
						value = { id: pi.id } satisfies HubOps["hosts.add"]["result"];
						break;
					}
					const host: HostConfig = {
						id: `h${Date.now().toString(36)}`,
						label: String(args.label || target),
						kind: "ssh",
						target,
						// The remote command is not settable from the page: a browser-reachable API that runs arbitrary
						// commands would turn any hub compromise into code execution. Custom commands live in hub.json.
					};
					if (this.configPath) updateHubHosts<HostConfig | PiHostConfig>(this.configPath, (hosts) => [...hosts, host]);
					this.config.hosts.push(host);
					this.#addLink(host).start();
					value = { id: host.id } satisfies HubOps["hosts.add"]["result"];
					break;
				}
				case "hosts.remove": {
					const hostId = String(args.id);
					const link = this.links.get(hostId);
					if (!link || link.config.kind === "local" || link.config.kind === "pi-local") throw new Error("Cannot remove this host");
					// The file changes first: a refused write leaves the Host connected and listed.
					if (this.configPath) updateHubHosts<HostConfig | PiHostConfig>(this.configPath, (hosts) => hosts.filter((h) => h.id !== hostId));
					await link.stop();
					this.links.delete(hostId);
					// Fail what was in flight and end open views instead of leaving them pending forever.
					this.#failPending(hostId);
					for (const { client, sid } of this.#hostSubs.get(hostId)?.values() ?? []) client.send({ t: "end", sid, reason: "host removed" });
					this.#hostSubs.delete(hostId);
					this.#hostReqs.delete(hostId);
					this.config.hosts.splice(this.config.hosts.findIndex((h) => h.id === hostId), 1);
					value = {} satisfies HubOps["hosts.remove"]["result"];
					break;
				}
				case "hosts.reconnect":
					this.links.get(String(args.id))?.reconnect();
					value = {} satisfies HubOps["hosts.reconnect"]["result"];
					break;
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
				client.send({ t: "hosts", hosts: this.hostStates() } satisfies HostsFrame);
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
			const body = this.#authorized(req) ? { ok: true, proof: hubProof(this.token), hosts: this.hostStates(), derive: deriveQueue(), builds: buildQueue(), loop: loopWindow() ?? null, missedInputs: [...this.links.values()].reduce((n, l) => n + (l instanceof PiHost ? l.missedInputs : 0), 0) } : { ok: true, proof: hubProof(this.token) };
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
		res.end(readFileSync(file));
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
