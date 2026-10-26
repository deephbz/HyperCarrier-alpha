import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import type { ModelRoleCatalog } from "../src/node/model-roles.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const fast = { name: "fast", use: "Quick edits", model: SIM, thinking: "off" };

test("Team: each lead selects Worker roles from the model-role catalog of its own cwd", async () => {
	const home = tempHome();
	const projects = { configured: join(home, "configured"), broken: join(home, "broken") };
	for (const dir of Object.values(projects)) mkdirSync(dir);
	const asked: string[] = [];
	const catalogs: Record<string, ModelRoleCatalog> = {
		[projects.configured]: { roles: [fast], defaultRole: "fast", invalidDefault: false, invalid: [], diagnostics: [] },
		[projects.broken]: { roles: [fast], defaultRole: "missing", invalidDefault: true, invalid: [], diagnostics: [] },
	};
	const modelRoles = { modelRoles: (cwd: string) => (asked.push(cwd), catalogs[cwd]!) };
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: await hydrate({ modelRoles }) });
	try {
		const client = await TestClient.connect(daemon.socket);
		const results = async (cwd: string) => {
			const prompt = ['/sim tool team_create {"name":"roles","purpose":"Check roles"}', '/sim tool ensure_worker {"name":"alice","scope":"Edits"}'].join("\n");
			const { threadId } = await client.req("thread.create", { cwd, model: SIM, prompt });
			const view = client.sub({ kind: "thread", threadId });
			const done = await client.until<any>(view, (v) => v.entries.filter((e: any) => e.kind === "tool-result").length === 2 && !v.live?.run, 15_000);
			return done.entries.filter((e: any) => e.kind === "tool-result").map((e: any) => JSON.parse(e.text));
		};
		const [created, ensured] = await results(projects.configured);
		assert.deepEqual(created.model_roles.map((r: any) => r.name), ["default", "fast"]);
		assert.equal(created.default_model_role, "fast");
		assert.equal(ensured.worker?.model_role, "fast", JSON.stringify(ensured));
		const [, refused] = await results(projects.broken);
		assert.equal(refused.reason, "invalid_model_role", JSON.stringify(refused));
		assert.deepEqual(refused.valid_model_roles.map((r: any) => r.name), ["default", "fast"]);
		assert.deepEqual([...new Set(asked)].sort(), [projects.broken, projects.configured].sort());
		client.close();
	} finally {
		await daemon.stop();
	}
});
