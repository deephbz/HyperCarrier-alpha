import "./bound.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Agent, fixture } from "./pi-fixtures.ts";

// Discovery fails each pass (agent list refused) while a slow start runs, so the server is marked unchecked when the
// spawn types its first prompt. The prompt must recheck the session, as other Herdr calls do, and not fail on a stale mark.
test("pi remote agent: a spawn's first prompt is typed after a discovery pass failed during the start", async (t) => {
	const f = fixture();
	const agent = Agent.start(f, { discoverMs: 50 });
	t.after(() => agent.stop());
	await agent.wait((x) => x.t === "agents" && x.agents.length > 0, "agents");
	f.setState({ ...f.state, listError: true, startDelayMs: 1000, sessionDelayMs: 600 });
	const requestId = randomUUID();
	const r = await agent.request({ t: "spawn", id: 1, requestId, sessionId: requestId, cwd: "/work", beside: "w1:p2", prompt: "hi" });
	assert.deepEqual([r.ok, r.evidence, r.submitted], [true, "started", { via: "keys", evidence: "sent" }]);
});
