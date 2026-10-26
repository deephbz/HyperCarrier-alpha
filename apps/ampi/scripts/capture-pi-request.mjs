#!/usr/bin/env node
// Records Pi's first model request for the synthetic setup in test/request-parity-fixture.ts into
// test/fixtures/pi-request.json, the reference node-request-parity.test.ts compares the durable node against.
// Run it after a Pi or Pi Team Bright upgrade: `node scripts/capture-pi-request.mjs [--pi <pi binary>]`.
// Pi runs in RPC mode with a disposable HOME, the fixture's settings, and the repository's Pi Team Bright and Cache
// Goblin extensions, the two the node also carries into the first request;
// a local endpoint answers with a synthetic stream, so the run costs nothing and sends nothing out.
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PARITY_MODEL, PARITY_PROMPT, PARITY_PROVIDER, requestShape, writeParityFixture } from "../test/request-parity-fixture.ts";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "..", "..");
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const install = join(homedir(), ".pi", "agent");
const pi = flag("--pi") ?? join(install, "bin", "pi");
const version = readFileSync(join(install, "install", "current-version"), "utf8").trim();
const piPackage = join(install, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
const ptb = join(repo, "packages", "pi-team-bright");
const goblin = join(repo, "packages", "pi-cache-goblin", "src", "extension.mjs");
const out = join(app, "test", "fixtures", "pi-request.json");

const base = realpathSync(mkdtempSync(join(tmpdir(), "ampi-pi-request-")));
const { home, agent, project } = writeParityFixture(base);
let captured;
const server = createServer((req, res) => {
	let text = "";
	req.on("data", (chunk) => (text += chunk));
	req.on("end", () => {
		captured ??= { body: JSON.parse(text), beta: req.headers["anthropic-beta"] };
		const events = [
			{ type: "message_start", message: { id: "msg_local", type: "message", role: "assistant", model: PARITY_MODEL.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
		res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
	});
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const models = { providers: { [PARITY_PROVIDER]: { api: "anthropic-messages", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "synthetic", models: [PARITY_MODEL] } } };
writeFileSync(join(agent, "models.json"), JSON.stringify(models));

const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(base, "sessions"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
for (const key of Object.keys(env)) if (/^(PI_TEAM|PI_MEMBERSHIP|PI_AGENT_NAME|PI_AGENT_LAUNCH|PI_SESSION|PI_INTERCOM|HERDR_)/.test(key) || /_API_KEY$/.test(key)) delete env[key];
const child = spawn(pi, ["--mode", "rpc", "--offline", "-e", join(ptb, "extensions", "index.ts"), "-e", goblin], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
child.stdout.once("data", () => child.stdin.write(`${JSON.stringify({ id: "capture", type: "prompt", message: PARITY_PROMPT })}\n`));
const deadline = Date.now() + 45_000;
while (!captured && Date.now() < deadline && child.exitCode === null) await new Promise((ok) => setTimeout(ok, 100));
child.kill("SIGTERM");
server.close();
rmSync(base, { recursive: true, force: true });
if (!captured) {
	console.error(`Pi sent no request within 45 s.\n${stderr.slice(-4000)}`);
	process.exit(1);
}
const shape = requestShape(captured.body, captured.beta, { [base]: "<FIXTURE>", [piPackage]: "<PI_PACKAGE>", [repo]: "<REPO>" });
const ptbVersion = JSON.parse(readFileSync(join(ptb, "package.json"), "utf8")).version;
writeFileSync(out, `${JSON.stringify({ source: { pi: version, piTeamBright: ptbVersion }, request: shape }, null, "\t")}\n`);
console.log(`wrote ${out}: ${shape.body.tools.length} tools, ${shape.body.system.length} system blocks`);
