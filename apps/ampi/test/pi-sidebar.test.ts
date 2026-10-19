import test from "node:test";
import assert from "node:assert/strict";
import { nestTeams, projectTeamRows } from "../web/src/components/team-nesting.ts";
import type { ThreadSummary } from "../src/shared/protocol.ts";

const thread = (id: string, role: "lead" | "worker" | undefined, teamId?: string, worker?: string) => ({
	id,
	team: role ? { role, teamId, worker } : undefined,
}) as ThreadSummary;

test("nestTeams places workers under their leader and preserves leader order", () => {
	const leadA = thread("lead-a", "lead", "team-a");
	const leadB = thread("lead-b", "lead", "team-b");
	const workerA = thread("worker-a", "worker", "team-a", "lens");
	const solo = thread("solo", undefined);
	const result = nestTeams([workerA, leadB, solo, leadA]);
	assert.deepEqual(result.map(({ row, children }) => [row.id, children.map((child) => child.id)]), [
		["lead-b", []], ["solo", []], ["lead-a", ["worker-a"]],
	]);
});

test("projectTeamRows hides collapsed workers and exposes their count", () => {
	const lead = thread("lead", "lead", "team");
	const workerA = thread("worker-a", "worker", "team", "lens");
	const workerB = thread("worker-b", "worker", "team", "side");
	const collapsed = projectTeamRows([lead, workerA, workerB], new Set(["team"]));
	assert.deepEqual(collapsed.map(({ row, child, hasChildren, open, count }) => ({ id: row.id, child, hasChildren, open, count })), [
		{ id: "lead", child: false, hasChildren: true, open: false, count: 2 },
	]);
	const expanded = projectTeamRows([lead, workerA, workerB], new Set());
	assert.deepEqual(expanded.map(({ row }) => row.id), ["lead", "worker-a", "worker-b"]);
});
