import "./bound.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { NodeRuntime } from "../src/node/runtime.ts";
import { tempHome } from "./helpers.ts";

function fixture(baseUrl: string, allowed: string[] = []) {
	const home = tempHome();
	let requests = 0;
	const fake = fauxProvider({ provider: "fakeco", api: "fakeco", models: [{ id: "m1" }] });
	fake.setResponses([() => { requests++; return fauxAssistantMessage("transport reached"); }]);
	const models = createModels(); models.setProvider(fake.provider);
	const options = { home, agentDir: join(home, "agent"), models, testProviders: allowed };
	const runtime = new NodeRuntime(options);
	return { runtime, model: { ...models.getModel("fakeco", "m1")!, baseUrl }, requests: () => requests };
}

test("test provider guard: unlisted providers cannot enter transport even on loopback", async () => {
	const f = fixture("http://127.0.0.1:9");
	try {
		await assert.rejects(async () => f.runtime.models.completeSimple(f.model, { messages: [] }), /AmPi test provider refused.*fakeco/);
		assert.equal(f.requests(), 0);
	} finally { await f.runtime.close(); }
});

test("test provider guard: an allowed fakeco with a non-loopback URL is refused before transport", async () => {
	const f = fixture("https://provider.invalid/v1", ["fakeco"]);
	try {
		for (const method of ["stream", "complete", "streamSimple", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred", "generateImages", "classify"] as const)
			await assert.rejects(async () => Reflect.apply(f.runtime.models[method], f.runtime.models, [f.model, { messages: [] }]), /AmPi test provider refused.*fakeco/);
		assert.equal(f.requests(), 0, "no transport callback, socket, or credential resolution may run");
	} finally { await f.runtime.close(); }
});

test("test provider guard: a scoped synthetic provider can use loopback or in-memory transport", async () => {
	for (const url of ["http://127.0.0.1:9", "http://[::1]:9", "http://localhost:9", ""]) {
		const f = fixture(url, ["fakeco"]);
		try {
			assert.equal((await f.runtime.models.completeSimple(f.model, { messages: [] })).stopReason, "stop");
			assert.equal(f.requests(), 1);
		} finally { await f.runtime.close(); }
	}
});
