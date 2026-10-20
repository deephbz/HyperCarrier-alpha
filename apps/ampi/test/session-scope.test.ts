import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isSessionInScope, SESSION_SCOPE_MS } from "../src/shared/session-scope.ts";

test("Session scope includes old live Sessions and excludes idle Sessions beyond 96 hours", () => {
	const now = 1_800_000_000_000;
	assert.equal(isSessionInScope({ activityAt: now - SESSION_SCOPE_MS - 30 * 86_400_000, live: true }, now), true);
	assert.equal(isSessionInScope({ activityAt: now - SESSION_SCOPE_MS - 60_000 }, now), false);
});
