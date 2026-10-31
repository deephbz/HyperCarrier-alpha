import "./bound.ts";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadHubConfig } from "../src/hub/hub.ts";

const TOKEN = "c".repeat(64);
// Cookies of other hubs on this host. They skip the hub's own port: Linux picks a test port from 32768-60999.
const stale = (n: number, own: number) => {
	const names: string[] = [];
	for (let p = 40000; names.length < n; p++) if (p !== own) names.push(`ampi_k_${p}=${"d".repeat(64)}`);
	return names;
};

async function withHub(options: { persistentCookie?: boolean }, run: (port: number) => Promise<void>) {
	const hub = new Hub({ hosts: [] }, { token: TOKEN, ...options });
	const port = await hub.listen(0);
	try { await run(port); } finally { await hub.close(); }
}

test("hub cookie: a login cookie lasts the client session unless the hub opts in to a persistent one", async () => {
	await withHub({}, async (port) => {
		const login = await fetch(`http://127.0.0.1:${port}/?k=${TOKEN}`, { redirect: "manual" });
		assert.equal(login.headers.get("set-cookie"), `ampi_k_${port}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
	});
	await withHub({ persistentCookie: true }, async (port) => {
		const login = await fetch(`http://127.0.0.1:${port}/?k=${TOKEN}`, { redirect: "manual" });
		assert.equal(login.headers.get("set-cookie"), `ampi_k_${port}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
	});
});

test("hub cookie: hub.json opts in with persistentCookie, and only true opts in", () => {
	const dir = mkdtempSync(join(tmpdir(), "hub-cookie-"));
	const at = (name: string, body: object) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(body)); return p; };
	assert.equal(loadHubConfig(at("on.json", { persistentCookie: true })).persistentCookie, true);
	assert.equal(loadHubConfig(at("pi.json", { backend: "pi", self: "box", persistentCookie: true })).persistentCookie, true);
	assert.equal(loadHubConfig(at("off.json", { persistentCookie: "yes" })).persistentCookie, undefined);
});

test("hub cookie: a client with 210 stale hub cookies still reaches the hub, which expires them and keeps its own", async () => {
	await withHub({}, async (port) => {
		const lines: string[] = [];
		const log = console.log;
		console.log = (...args: unknown[]) => lines.push(args.join(" "));
		let res: Response;
		const piled = { cookie: [...stale(210, port), `ampi_k_${port}=${TOKEN}`].join("; "), "user-agent": "AmPiPerf-test" };
		try {
			res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: piled });
			// A second piled-up request from the same client within a minute heals again but does not log again.
			assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`, { headers: piled })).headers.getSetCookie().length, 210);
		} finally {
			console.log = log;
		}
		assert.equal(res.status, 200, "the request is not refused before the hub sees it");
		const expired = res.headers.getSetCookie();
		assert.equal(expired.length, 210);
		// The expiring cookie matches the login cookie exactly except for its lifetime, or the client keeps the old one.
		assert.equal(expired[0], `${stale(1, port)[0]!.split("=")[0]}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
		assert(!expired.some((c) => c.startsWith(`ampi_k_${port}=`)), "the hub never expires its own login");
		assert.deepEqual(lines.filter((l) => l.includes("expired")), [`hub: expired 210 stale ampi_k_* cookies from a client (AmPiPerf-test)`]);
	});
});

test("hub cookie: a few cookies of other hubs stay; only a pile-up heals", async () => {
	await withHub({}, async (port) => {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { cookie: stale(32, port).join("; ") } });
		assert.deepEqual(res.headers.getSetCookie(), [], "a client with up to 32 hub cookies keeps them: other hubs on this host stay signed in");
	});
});

test("hub cookie: headers past the server limit get a readable 431 that says how to recover, then the connection closes", async () => {
	await withHub({}, async (port) => {
		const reply = await new Promise<string>((done, fail) => {
			const socket = connect(port, "127.0.0.1", () => socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${stale(900, port).join("; ")}\r\n\r\n`));
			let text = "";
			socket.on("data", (d) => (text += d)).on("end", () => done(text)).on("close", () => done(text)).on("error", fail);
		});
		assert.match(reply, /^HTTP\/1\.1 431 /);
		assert.match(reply, /\r\nConnection: close\r\n/i);
		assert.match(reply, /too many AmPi cookies/i);
		assert.match(reply, /ampi open/);
	});
});
