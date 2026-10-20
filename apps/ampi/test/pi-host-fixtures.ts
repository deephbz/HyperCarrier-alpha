import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import { Browser } from "./helpers.ts";
import { control, fixture } from "./pi-fixtures.ts";
import { PI_VIEWS } from "../src/pi/views/index.ts";
import { modelLimits } from "../src/pi/host.ts";
import type { HostedView, PiViewContext } from "../src/pi/views/types.ts";
import type { ViewTopic } from "../src/shared/protocol.ts";

/** Every helper model, explicit: hub helper models have no built-in default. */
export const HELPER_MODELS = { arcLabels: "anthropic/claude-haiku-5-5", arcSynthesis: "anthropic/claude-sonnet-5-5", rarebitRecap: "anthropic/claude-haiku-5-5", rarebitAsk: "anthropic/claude-sonnet-5-5" };

export const TOKEN = "c".repeat(64);
export const iso = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
export const line = (o: unknown) => `${JSON.stringify(o)}\n`;
export const user = (id: string, parent: string | null, n: number, text: string) =>
	line({ type: "message", id, parentId: parent, timestamp: iso(n), message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(iso(n)) } });
export const assistant = (id: string, parent: string, n: number, text: string) =>
	line({
		type: "message",
		id,
		parentId: parent,
		timestamp: iso(n),
		message: {
			role: "assistant",
			content: [{ type: "text", text }, { type: "toolCall", id: `call-${id}`, name: "bash", arguments: { command: "ls" } }],
			model: "model-x",
			provider: "prov",
			usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0.25 } },
			timestamp: Date.parse(iso(n)),
		},
	});
export const toolResult = (id: string, parent: string, n: number, callId: string) =>
	line({ type: "message", id, parentId: parent, timestamp: iso(n), message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false } });

/** One hub with one Pi Host on this machine, named by its alias, driven by a fake Herdr and synthetic Sessions. */
export async function setup(t: { after: (fn: () => unknown) => void }, { agent, ...host }: Record<string, unknown> = {}) {
	const f = fixture();
	const header = (id: string) => line({ type: "session", version: 3, id, timestamp: iso(0), cwd: "/work" });
	writeFileSync(f.sessionA, header("sess-a") + user("u1", null, 1, "list the files") + assistant("a1", "u1", 2, "Listing.") + toolResult("r1", "a1", 3, "call-a1"));
	writeFileSync(f.sessionB, header("sess-b") + user("u1", null, 1, "other work"));
	const hub = new Hub(
		{
			hosts: [
				{
					id: "devbox",
					label: "devbox",
					kind: "pi-local",
					cacheDir: join(f.dir, "cache"),
					agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teams: false, controlStatusMs: 300, ...(agent as object | undefined) },
					// A stand-in model that answers with the prompt's length and first line.
					askCommand: [process.execPath, "-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(s.startsWith('fail')||s.includes('\"fail now\"'))process.exit(3);console.log(s.length+':'+s.split('\\n')[0])})"],
					env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") },
					...host,
				},
			],
			backend: "pi",
			models: HELPER_MODELS,
		},
		{ token: TOKEN },
	);
	const port = await hub.listen(0);
	const browser = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
	t.after(async () => {
		browser.ws.close();
		await hub.close();
	});
	return { f, hub, browser };
}

/** A view outside the registry, for tests of the view machinery: its value is no declared wire value, so the cast stays here. */
export function testView(name: string, value: (ctx: PiViewContext, topic: ViewTopic) => unknown): HostedView {
	return { name, value: value as HostedView["value"] };
}
