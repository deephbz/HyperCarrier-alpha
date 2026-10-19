import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGraph, derivedStatus, initialTeamState, LEAD, readyFrontier, Refusal, type TeamState, updateTask } from "../src/graph.ts";

function team(): TeamState {
	const s = initialTeamState();
	s.team = { name: "t", purpose: "p", createdAt: 0, status: "active", leadConversationId: "1" };
	for (const name of ["alice", "bob"])
		s.workers[name] = { name, scope: name, createdAt: 0, membership: { id: `${name}#1`, generation: 1, conversationId: name, active: true } };
	return s;
}

const v = (s: TeamState, k: string) => s.tasks[k]!.version;

test("claim needs readiness, one Task per Worker, and the current version", () => {
	const s = team();
	applyGraph(s, { tasks: [
		{ key: "a", title: "A", goal: "g", assignee: "alice" },
		{ key: "b", title: "B", goal: "g", assignee: "alice" },
		{ key: "c", title: "C", goal: "g", assignee: "bob", needs: ["a"] },
	] }, 1);
	assert.deepEqual(readyFrontier(s), ["a"]);
	assert.throws(() => updateTask(s, "alice", { task_id: "c", expected_version: v(s, "c"), transition: "claim" }, 2), (e: Refusal) => e.reason === "worker_mismatch");
	const stale = v(s, "a");
	updateTask(s, "alice", { task_id: "a", expected_version: stale, transition: "claim" }, 2);
	assert.throws(() => updateTask(s, "alice", { task_id: "a", expected_version: stale, transition: "block", evidence: "x" }, 3), (e: Refusal) => e.reason === "version_conflict");
	assert.throws(() => updateTask(s, "alice", { task_id: "b", expected_version: v(s, "b"), transition: "claim" }, 3), (e: Refusal) => e.reason === "worker_occupied");
	assert.throws(() => updateTask(s, "alice", { task_id: "a", expected_version: v(s, "a"), transition: "goal_achieved" }, 3), (e: Refusal) => e.reason === "evidence_required");
	updateTask(s, "alice", { task_id: "a", expected_version: v(s, "a"), transition: "goal_achieved", evidence: "ok" }, 4);
	assert.equal(derivedStatus(s, "c").status, "ready");
	assert.deepEqual(readyFrontier(s).sort(), ["b", "c"]);
});

test("graph apply needs the current graph version after the first apply", () => {
	const s = team();
	applyGraph(s, { tasks: [{ key: "a", title: "A", goal: "g", assignee: "alice" }] }, 1);
	assert.throws(() => applyGraph(s, { tasks: [] }, 2), (e: Refusal) => e.reason === "graph_version_conflict");
	assert.throws(() => applyGraph(s, { expected_graph_version: "g_1", tasks: [{ key: "x", title: "X", goal: "g", assignee: "zed" }] }, 2), (e: Refusal) => e.reason === "worker_unavailable");
	assert.throws(
		() => applyGraph(s, { expected_graph_version: "g_1", tasks: [{ key: "x", title: "X", goal: "g", assignee: "bob", needs: ["y"] }, { key: "y", title: "Y", goal: "g", assignee: "bob", needs: ["x"] }] }, 2),
		(e: Refusal) => e.reason === "invalid_graph",
	);
});

test("a failure edge reopens its target and the path to the failed Task, then exhausts", () => {
	const s = team();
	applyGraph(s, { tasks: [
		{ key: "build", title: "B", goal: "g", assignee: "alice" },
		{ key: "test", title: "T", goal: "g", assignee: "bob", needs: ["build"], on_goal_failed: { target: "build", max_traversals: 1 } },
		{ key: "ship", title: "S", goal: "g", assignee: "bob", needs: ["test"] },
	] }, 1);
	const finish = (worker: string, key: string, outcome: "goal_achieved" | "goal_failed", t: number) => {
		updateTask(s, worker, { task_id: key, expected_version: v(s, key), transition: "claim" }, t);
		return updateTask(s, worker, { task_id: key, expected_version: v(s, key), transition: outcome, evidence: "e" }, t + 1);
	};
	finish("alice", "build", "goal_achieved", 2);
	const failed = finish("bob", "test", "goal_failed", 4);
	assert.equal(failed.traversal, "build");
	assert.equal(derivedStatus(s, "build").status, "ready");
	assert.equal(derivedStatus(s, "test").status, "dependency_waiting");
	assert.equal(s.tasks.build!.attempts.length, 1, "the earlier attempt is kept as evidence");
	finish("alice", "build", "goal_achieved", 6);
	finish("bob", "test", "goal_failed", 8);
	assert.deepEqual(derivedStatus(s, "test"), { status: "goal_failed", reason: "failure_edge_exhausted" });
	assert.deepEqual(derivedStatus(s, "ship"), { status: "goal_failed", reason: "dependency_failed" });
	assert.throws(() => updateTask(s, "bob", { task_id: "ship", expected_version: v(s, "ship"), transition: "cancel", evidence: "x" }, 10), (e: Refusal) => e.reason === "worker_mismatch");
	updateTask(s, LEAD, { task_id: "build", expected_version: v(s, "build"), current_context: "note" }, 11);
});
