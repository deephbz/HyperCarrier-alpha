import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { runDaemon } from "../src/node/daemon.ts";
import { openModels } from "../src/node/models.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

/** A provider that accepts exactly the key "good-key", like a real API answering 401 to anything else. */
function testProvider() {
	const handle = fauxProvider({ provider: "testco", api: "testco", models: [{ id: "t1", name: "TestCo One" }] });
	const step = (_context: unknown, options: { apiKey?: string } | undefined) => {
		handle.appendResponses([step as never]);
		return options?.apiKey === "good-key"
			? fauxAssistantMessage([fauxText("OK")])
			: fauxAssistantMessage([], { stopReason: "error", errorMessage: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' });
	};
	handle.setResponses([step as never]);
	return { ...handle.provider, name: "TestCo", auth: { apiKey: envApiKeyAuth("TestCo API key", ["TESTCO_API_KEY"]) } };
}

test("accounts: sign-in runs the provider's own flow, is confirmed with the provider, and lands in pi's auth.json", async () => {
	const home = tempHome();
	const agentDir = join(home, "pi-agent");
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const models = openModels({ sim: { tokensPerSecond: 20000 } });
	models.setProvider(testProvider() as never);
	const daemon = await runDaemon({ home, models, plugins: await hydrate() });
	const auth = join(agentDir, "auth.json");
	const signIn = async (client: TestClient, key: string) => {
		const started = await client.req("accounts.login", { providerId: "testco", type: "api_key" });
		const login = client.sub({ kind: "login", loginId: started.id });
		const asking = await client.until<any>(login, (v) => v.prompt);
		assert.equal(asking.prompt.type, "secret", "the key is asked for as a secret");
		await client.req("accounts.answer", { loginId: started.id, promptId: asking.prompt.id, value: key });
		return client.until<any>(login, (v) => v.status !== "running");
	};
	try {
		const client = await TestClient.connect(daemon.socket);
		const before = await client.req("accounts.list", {});
		assert.equal(before.find((p: any) => p.id === "testco").signedIn, false);
		assert.ok(before.find((p: any) => p.id === "anthropic").methods.length > 0, "real providers offer their own flows");

		// A key the provider rejects is not "signed in": the flow says why and nothing stays stored.
		const rejected = await signIn(client, "sk-fake");
		assert.equal(rejected.status, "error");
		assert.match(rejected.error, /TestCo did not accept this sign-in: invalid x-api-key \(401\)\. Nothing was saved/);
		assert.equal((await client.req("accounts.list", {})).find((p: any) => p.id === "testco").signedIn, false);
		assert.ok(!existsSync(auth) || JSON.parse(readFileSync(auth, "utf8")).testco === undefined);

		// A working key is confirmed, stored privately, offered in model menus, and never sent back out.
		const accepted = await signIn(client, "good-key");
		assert.equal(accepted.status, "done", JSON.stringify(accepted));
		assert.equal(accepted.warning, undefined);
		assert.equal(statSync(auth).mode & 0o777, 0o600);
		assert.equal(JSON.parse(readFileSync(auth, "utf8")).testco.key, "good-key");
		const after = await client.req("accounts.list", {});
		assert.equal(after[0].id, "testco", "signed-in providers come first");
		assert.ok((await client.req("models.list", {})).some((m: any) => m.provider === "testco"));
		assert.ok(!JSON.stringify(after).includes("good-key"), "the key never travels back out");

		// A rejected new key does not cost the working one it would have replaced.
		const mistyped = await signIn(client, "good-kye");
		assert.equal(mistyped.status, "error");
		assert.match(mistyped.error, /Your previous sign-in is kept/);
		assert.equal(JSON.parse(readFileSync(auth, "utf8")).testco.key, "good-key");

		// A cancelled flow ends without storing anything.
		const second = await client.req("accounts.login", { providerId: "openai", type: "api_key" });
		const view = client.sub({ kind: "login", loginId: second.id });
		await client.until<any>(view, (v) => v.prompt);
		await client.req("accounts.cancel", { loginId: second.id });
		await client.until<any>(view, (v) => v.status === "cancelled");
		assert.equal(JSON.parse(readFileSync(auth, "utf8")).openai, undefined);

		await client.req("accounts.logout", { providerId: "testco" });
		assert.equal((await client.req("accounts.list", {})).find((p: any) => p.id === "testco").signedIn, false);
		client.close();
	} finally {
		await daemon.stop();
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	}
});
