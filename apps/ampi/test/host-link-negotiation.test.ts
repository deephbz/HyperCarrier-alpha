import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { HostConfig } from "../src/hub/hosts.ts";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { socketPath } from "../src/node/daemon.ts";
import { HostLink, type HostState } from "../src/hub/hosts.ts";
import { PROTOCOL } from "../src/shared/protocol.ts";
import { buildId } from "../src/shared/build.ts";

// A local HostLink against a fake node socket. The fake node always listens, so the link never starts a real node.
// Each case sets what the fake node says when the link connects.

const home = mkdtempSync(join(tmpdir(), "ampi-link-"));
const node = { nodeId: "n1", hostname: "fake", platform: "darwin", user: "u", home, version: "0", build: buildId(), pid: 4242, startedAt: 0, storage: "x" };
const hello = (over: object = {}) => `${JSON.stringify({ t: "hello", protocol: PROTOCOL, node, ...over })}\n`;
let answer: (socket: Socket) => void = () => {};
let server: Server;
const links: HostLink[] = [];
const saved = { negotiate: HostLink.NEGOTIATE_MS, silent: HostLink.SILENT_MS, tick: HostLink.SILENT_TICK_MS };

before(async () => {
	HostLink.NEGOTIATE_MS = 400;
	HostLink.SILENT_MS = 400;
	HostLink.SILENT_TICK_MS = 50;
	server = createServer((socket) => {
		socket.on("error", () => {});
		answer(socket);
	});
	await new Promise<void>((resolve) => server.listen(socketPath(home), resolve));
});

after(async () => {
	for (const link of links) link.stop();
	Object.assign(HostLink, { NEGOTIATE_MS: saved.negotiate, SILENT_MS: saved.silent, SILENT_TICK_MS: saved.tick });
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(home, { recursive: true, force: true });
});

function start(config: Partial<HostConfig> = {}): { link: HostLink; states: HostState[] } {
	const link = new HostLink({ id: "fake", label: "fake", kind: "local", home, ...config });
	const states: HostState[] = [];
	link.on("state", (state: HostState) => states.push(state));
	links.push(link);
	link.start();
	return { link, states };
}

async function until(link: HostLink, done: (state: HostState) => boolean, ms = 3_000): Promise<HostState> {
	const end = Date.now() + ms;
	while (!done(link.state)) {
		if (Date.now() > end) throw new Error(`timed out; state ${JSON.stringify(link.state)}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return link.state;
}

/** Every state but connected names when it began and the next step, so no view can show a bare "connecting". */
function assertExplained(states: HostState[]): void {
	for (const state of states) {
		if (state.status === "connected") continue;
		assert.ok(state.since > 0 && state.hint.length > 0, `unexplained state ${JSON.stringify(state)}`);
		if (state.status === "connecting") assert.ok(state.phase === "transport" || state.phase === "hello");
	}
}

test("a node that accepts and stays silent fails at the deadline, and the retry keeps the failure until a hello", async () => {
	answer = () => {};
	const { link, states } = start();
	const down = await until(link, (s) => s.status === "disconnected");
	assert.match(down.status === "disconnected" ? down.error : "", /accepted the connection but sent no hello/);
	assert.match(down.hint ?? "", /ampi doctor/);
	const retry = await until(link, (s) => s.status === "connecting" && s.attempts === 2);
	assert.match(retry.error ?? "", /sent no hello/, "the retry keeps the last failure visible");
	// The operator reconnects during the silent attempt; the replaced attempt must not leak into the new one.
	answer = (socket) => socket.write(hello());
	link.reconnect();
	assert.match(link.state.error ?? "", /sent no hello/, "an operator reconnect keeps the failure too");
	const up = await until(link, (s) => s.status === "connected");
	assert.equal(up.error, undefined, "a hello clears the failure");
	assert.equal(up.hint, undefined);
	assertExplained(states);
	assert.ok(states.some((s) => s.status === "connecting" && s.phase === "hello"), "the link reports the hello phase");
	link.stop();
});

test("bytes without a valid hello fail at the deadline and quote what the node sent", async () => {
	answer = (socket) => socket.write("Welcome to the shell!\n");
	const { link, states } = start();
	const down = await until(link, (s) => s.status === "disconnected");
	assert.match(down.error ?? "", /no valid hello.*Welcome to the shell!/);
	assertExplained(states);
	link.stop();
});

test("a hello without a node fails at once", async () => {
	answer = (socket) => socket.write(hello({ node: undefined }));
	const started = Date.now();
	const { link } = start();
	const down = await until(link, (s) => s.status === "disconnected");
	assert.match(down.error ?? "", /names no node/);
	assert.ok(Date.now() - started < HostLink.NEGOTIATE_MS, "an invalid hello needs no deadline");
	link.stop();
});

test("a node of another protocol fails at once and names its pid", async () => {
	answer = (socket) => socket.write(hello({ protocol: "ampi/0" }));
	const { link, states } = start();
	const down = await until(link, (s) => s.status === "disconnected");
	assert.match(down.error ?? "", /speaks ampi\/0/);
	assert.match(down.hint ?? "", /pid 4242/);
	assert.ok(!states.some((s) => s.status === "connected"), "a mismatched node never counts as connected");
	link.stop();
});

test("a connected node that goes silent is dropped after SILENT_MS", async () => {
	answer = (socket) => socket.write(hello());
	const { link, states } = start();
	await until(link, (s) => s.status === "connected");
	const down = await until(link, (s) => s.status === "disconnected");
	assert.match(down.error ?? "", /No frame from the node/);
	assertExplained(states);
	link.stop();
});

/** The disconnected states an attempt reported before the retry started: an attempt that ends once reports one. */
const endsBeforeRetry = (states: HostState[]) => states.slice(0, states.findIndex((s) => s.attempts === 2)).filter((s) => s.status === "disconnected").length;

test("a node start that fails after the deadline ends its attempt once and schedules one retry", async (t) => {
	const connect = HostLink.connectNode;
	t.after(() => { HostLink.connectNode = connect; });
	HostLink.connectNode = () => new Promise((_, reject) => setTimeout(() => reject(new Error("AmPi node did not start")), HostLink.NEGOTIATE_MS + 100));
	const { link, states } = start();
	const down = await until(link, (s) => s.status === "disconnected");
	assert.match(down.error ?? "", /No node socket after/);
	await until(link, (s) => s.attempts === 2);
	assert.equal(endsBeforeRetry(states), 1, "the late rejection does not end the attempt again");
	link.stop();
});

test("an ssh that cannot start (error, then close) ends its attempt once and schedules one retry", async (t) => {
	const path = process.env.PATH;
	const empty = mkdtempSync(join(tmpdir(), "ampi-nopath-"));
	t.after(() => { process.env.PATH = path; rmSync(empty, { recursive: true, force: true }); });
	process.env.PATH = empty;
	const { link, states } = start({ kind: "ssh", target: "nowhere", home: undefined });
	const down = await until(link, (s) => s.status === "disconnected");
	assert.match(down.error ?? "", /ENOENT/);
	assert.match(down.hint ?? "", /ssh is installed/);
	await until(link, (s) => s.attempts === 2);
	assert.equal(endsBeforeRetry(states), 1, "the close after the spawn error does not end the attempt again");
	link.stop();
});
