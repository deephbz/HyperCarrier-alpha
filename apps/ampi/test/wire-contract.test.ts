import "./bound.ts";
// The hub → browser contract (docs/wire-boundary.md): the registry in src/shared/protocol.ts is its one authority.
// The type assertions here run under `npm run typecheck`; each `@ts-expect-error` must stay used, so a contract
// that stops refusing a wrong shape fails the typecheck. The tests run in the fast lane.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue } from "../src/node/durable-types.ts";
import { PiHost } from "../src/pi/host.ts";
import { replaceFile } from "./pi-fixtures.ts";
import { setup } from "./pi-host-fixtures.ts";
import type { OpHandlers, OpName, OpResult, Ops, PiTopicValues, ViewName, ViewTopic, ViewTopics } from "../src/shared/protocol.ts";

// ---- Negative compile tests ----

export const wrongResult: OpHandlers<"thread.withdraw"> = {
	// @ts-expect-error a handler must return its op's declared result
	"thread.withdraw": async () => ({ withdrawn: "yes" }),
};

export function readsWrongField(created: OpResult<"thread.create">): unknown {
	// @ts-expect-error a caller reads only the fields the result declares
	return created.threadID;
}

// @ts-expect-error an op name outside the registry is no OpName
export const unknownOp: OpName = "thread.nope";

// @ts-expect-error a view topic carries only its view's parameters
export const wrongParam: ViewTopic<"cos.timeline"> = { kind: "view", view: "cos.timeline", before: "x" };

// ---- NoEscape: every declared value is a shape ----

type IsAny<T> = 0 extends 1 & T ? true : false;
/**
 * The paths below `P` where `T` stops declaring its shape: `any`, `unknown`, the whole `JsonValue` union, or an index
 * signature (whose values are searched too). `Record<string, never>` declares nothing and is no escape.
 */
type Escapes<T, P extends string, D extends 0[] = []> =
	D["length"] extends 10 ? never
	: IsAny<T> extends true ? `${P}: any`
	: unknown extends T ? `${P}: unknown`
	: JsonValue extends T ? `${P}: JsonValue`
	: T extends readonly (infer E)[] ? Escapes<E, `${P}[]`, [...D, 0]>
	: T extends object
		? string extends keyof T
			? [T[string]] extends [never] ? never : `${P}: index signature` | Escapes<T[string], `${P}[*]`, [...D, 0]>
			: { [K in keyof T & string]-?: Escapes<T[K], `${P}.${K}`, [...D, 0]> }[keyof T & string]
	: never;
type Found =
	| { [K in OpName]: Escapes<Ops[K]["result"], K> }[OpName]
	| { [N in ViewName]: Escapes<ViewTopics[N]["value"], `view ${N}`> }[ViewName]
	| { [K in keyof PiTopicValues]: Escapes<PiTopicValues[K], `topic ${K}`> }[keyof PiTopicValues];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** No declared value escapes: a new escape fails this equality. */
export const noEscape: Equal<Found, never> = true;

// ---- The registry and the Host's dispatch table ----

/** Every op name, checked against the registry both ways: `satisfies` refuses a missing and an extra key. */
const OP_NAMES = {
	"thread.submit": true, "thread.abort": true, "thread.withdraw": true, "thread.commands": true, "thread.command": true, "thread.create": true, "thread.resume": true, "thread.close": true,
	"sessions.search": true, "thread.outline": true, "thread.find": true, "thread.history": true, "thread.entry": true, "prompts.list": true, "models.list": true,
	"view.rarebit.ask": true, "view.cos.timeline.locate": true, "view.arc.build": true,
} satisfies Record<OpName, true>;

test("wire contract: the Host serves every registry op and nothing else", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-wire-contract-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const host = new PiHost({ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: dir });
	const served = new Set(host.opNames()), declared = new Set(Object.keys(OP_NAMES));
	assert.deepEqual([...served].filter((op) => !declared.has(op)), [], "handlers without a registry entry");
	assert.deepEqual([...declared].filter((op) => !served.has(op)), [], "registry entries without a handler");
});

test("wire contract: an unknown or unsupported request completes with its error frame and never hangs", async (t) => {
	const { browser } = await setup(t);
	const refused = (op: string, args: unknown) =>
		Promise.race([
			browser.req("devbox", op, args).then(() => ({ code: "answered" }), (error: { code?: string; message: string }) => ({ code: error.code, message: error.message })),
			new Promise<{ code: string }>((resolve) => setTimeout(() => resolve({ code: "no answer in 5 s" }), 5000).unref()),
		]);
	// An old or newer browser may send a name this build lacks (a slash command op hung the composer this way).
	assert.deepEqual(await refused("thread.slashCommands", { threadId: "pi:sess-a" }), { code: "unsupported", message: "thread.slashCommands is not available for Pi Sessions yet" });
	assert.deepEqual(await refused("view.nope.build", {}), { code: "unsupported", message: "view.nope.build is not available" });
	assert.deepEqual(await refused("thread.compact", { threadId: "pi:sess-a" }), { code: "unsupported", message: "thread.compact is not available for Pi Sessions yet" }, "a node-backend op");
	assert.deepEqual(await refused("thread.submit", { threadId: "pi:sess-nope", content: "x", images: [{ data: "", mimeType: "image/png" }] }), { code: "not_found", message: "Unknown Session on this Host" }, "a handler's own refusal");
});

test("wire contract: the Host's op table keeps its order: host ops, then view ops", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-wire-contract-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const host = new PiHost({ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: dir });
	assert.deepEqual(host.opNames(), [
		"thread.submit", "thread.commands", "thread.command", "thread.abort", "thread.withdraw", "thread.create", "thread.resume", "thread.close",
		"sessions.search", "thread.outline", "thread.find", "thread.history", "thread.entry", "prompts.list", "models.list",
		"view.rarebit.ask", "view.cos.timeline.locate", "view.arc.build",
	]);
});

test("wire contract: a host op refuses bad arguments with its code and exact text", async (t) => {
	const { f, browser } = await setup(t);
	const refusal = (op: string, args: unknown) =>
		browser.req("devbox", op, args).then(() => ({ code: "answered" }), (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }));
	const requestId = "00000000-0000-0000-0000-000000000001";
	assert.deepEqual(await refusal("thread.submit", { threadId: "pi:sess-nope", content: "" }), { code: "invalid", message: "Empty message" });
	assert.deepEqual(await refusal("thread.create", { requestId: "not-a-uuid", cwd: "/work", place: { workspace: "new" } }), { code: "invalid", message: "requestId must be a UUID" });
	assert.deepEqual(await refusal("thread.create", { requestId, place: { workspace: "new" } }), { code: "invalid", message: "A working directory is required" });
	assert.deepEqual(await refusal("thread.create", { requestId, cwd: "/work", place: {} }), { code: "invalid", message: 'place must be { beside, direction } or { workspace: "new" }' });

	// A live control that serves commands but answers one without a disposition: the outcome is unknown.
	const ctl = await dispositionlessControl(f.agentDir, f.sessionA);
	t.after(() => ctl.close());
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true);
	assert.deepEqual(await refusal("thread.command", { threadId: "pi:sess-a", name: "review" }), { code: "control_unconfirmed", message: "The control sent no disposition; the outcome is unknown" });
});

/** A Pi control endpoint for sess-a whose command acks carry no disposition. */
async function dispositionlessControl(agentDir: string, sessionFile: string) {
	const dir = join(agentDir, "hc-control");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const server = createServer((c) => {
		let buf = "";
		c.setEncoding("utf8");
		c.on("error", () => {});
		c.on("data", (d: string) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const req = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				const reply = req.op === "status"
					? { id: req.id, ok: true, value: { sessionId: "sess-a", sessionFile, nonce: "n-live", idle: true, compacting: false, pending: { steer: 0, followUp: 0 }, commands: 1 } }
					: { id: req.id, ok: true, via: "control" };
				c.write(`${JSON.stringify(reply)}\n`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(join(dir, "sess-a.sock"), resolve));
	replaceFile(join(dir, "sess-a.json"), JSON.stringify({ schema: "hc-control/1", sessionId: "sess-a", sessionFile, pid: process.pid, nonce: "n-live", startedAt: Date.now(), version: "test" }));
	return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("wire contract: the cast lint finds each banned escape and ignores comments and strings", () => {
	const { scan } = createRequire(import.meta.url)("../scripts/lint-casts.cjs") as { scan: (file: string, text: string) => string[] };
	const found = scan("x.ts", 'const a = b as never; const c = (d as unknown) as E; let f: any; // as never, any\nconst g = "as unknown as";');
	assert.deepEqual(found, ["x.ts:1:11 `as never`", "x.ts:1:33 `as unknown as`", "x.ts:1:61 `any`"]);
});
