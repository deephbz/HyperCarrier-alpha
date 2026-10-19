// Pi Team Bright's Task-graph semantics as pure functions over one JSON state, so the pi-durable adapter can apply
// them inside a single atomic commit. The state is the only Task authority of a Team (hc-team-orchestration.md);
// presentation, delivery, and worker activity never change it.

import type { JsonValue } from "@earendil-works/chord";

export type TaskStatus = "pending" | "in_progress" | "blocked" | "goal_achieved" | "goal_failed" | "cancelled";
export type DerivedStatus = TaskStatus | "dependency_waiting" | "ready";
export type FailureReason = "criterion_failed" | "failure_edge_exhausted" | "dependency_failed" | "dependency_cancelled";

export type TaskInput = {
	key: string;
	title: string;
	goal: string;
	assignee: string;
	needs?: string[];
	on_goal_failed?: { target: string; max_traversals: number };
};

export type Attempt = {
	id: string;
	ordinal: number;
	startedAt: number;
	endedAt?: number;
	outcome?: "goal_achieved" | "goal_failed" | "cancelled" | "superseded";
	evidence?: string;
};

export type Task = TaskInput & {
	needs: string[];
	/** Authored status; `pending` is rendered as dependency_waiting or ready. */
	status: TaskStatus;
	failureReason?: FailureReason;
	current_context: string;
	evidence?: string;
	version: string;
	versionSeq: number;
	attempts: Attempt[];
	traversals: number;
	updatedAt: number;
};

export type TeamEvent = {
	seq: number;
	ts: number;
	kind:
		| "team_created"
		| "worker_ensured"
		| "worker_stopped"
		| "graph_applied"
		| "task_claimed"
		| "task_blocked"
		| "task_resumed"
		| "task_goal_achieved"
		| "task_goal_failed"
		| "task_cancelled"
		| "task_context_updated"
		| "failure_edge_traversed"
		| "alert_sent"
		| "delivery_submitted"
		| "delivery_settled"
		| "team_shutdown";
	actor: string;
	task?: string;
	worker?: string;
	detail?: string;
};

export type Worker = {
	name: string;
	scope: string;
	modelRole?: string;
	createdAt: number;
	/** Current Membership generation; a stopped Worker keeps its record with `active: false`. */
	membership: { id: string; generation: number; conversationId: string; active: boolean; deactivationReason?: string };
};

export type Alert = { id: string; ts: number; from: string; to: string; kind: string; text: string; task_id?: string };

/**
 * Acceptance and delivery are separate facts (P7): `accepted` is written with the authority change in one commit; a
 * delivery task later records `submitted` (the recipient's inbox owns it) and `settled` (the recipient answered).
 */
export type Delivery = {
	id: string;
	to: string;
	toConversationId: string;
	kind: "task" | "alert" | "update";
	ref: string;
	acceptedAt: number;
	submittedAt?: number;
	submissionId?: string;
	settledAt?: number;
	settled?: string;
};

export type TeamState = {
	team?: {
		name: string;
		purpose: string;
		createdAt: number;
		status: "active" | "stopped";
		leadConversationId: string;
	};
	workers: Record<string, Worker>;
	tasks: Record<string, Task>;
	graphVersion: string;
	graphSeq: number;
	/** Idempotency receipts keyed by operation; `result` is the plain-JSON tool output replayed on retry. */
	receipts: Record<string, { fingerprint: string; result: JsonValue }>;
	events: TeamEvent[];
	eventSeq: number;
	alerts: Alert[];
	deliveries: Record<string, Delivery>;
	syncCursor: number;
};

export const LEAD = "team-lead";
const MAX_EVENTS = 400;
const MAX_ALERTS = 100;
const MAX_DELIVERIES = 300;

export function initialTeamState(): TeamState {
	return {
		workers: {},
		tasks: {},
		graphVersion: "g_0",
		graphSeq: 0,
		receipts: {},
		events: [],
		eventSeq: 0,
		alerts: [],
		deliveries: {},
		syncCursor: 0,
	};
}

export class Refusal extends Error {
	readonly reason: string;
	readonly extra: Record<string, unknown>;
	constructor(reason: string, message: string, extra: Record<string, unknown> = {}) {
		super(message);
		this.reason = reason;
		this.extra = extra;
	}
}

export function record(state: TeamState, event: Omit<TeamEvent, "seq" | "ts">, now: number): void {
	state.eventSeq += 1;
	state.events.push({ ...event, seq: state.eventSeq, ts: now });
	if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

export function pushAlert(state: TeamState, alert: Alert): void {
	state.alerts.push(alert);
	if (state.alerts.length > MAX_ALERTS) state.alerts.splice(0, state.alerts.length - MAX_ALERTS);
}

export function pushDelivery(state: TeamState, delivery: Delivery): void {
	state.deliveries[delivery.id] = delivery;
	const ids = Object.keys(state.deliveries);
	if (ids.length > MAX_DELIVERIES) {
		const settled = ids.filter((id) => state.deliveries[id]!.settledAt !== undefined).slice(0, ids.length - MAX_DELIVERIES);
		for (const id of settled) delete state.deliveries[id];
	}
}

function bump(task: Task, now: number): void {
	task.versionSeq += 1;
	task.version = `v_${task.versionSeq.toString(16).padStart(8, "0")}${Math.floor(now % 0xffffffff).toString(16).padStart(8, "0")}`;
	task.updatedAt = now;
}

export function derivedStatus(state: TeamState, key: string): { status: DerivedStatus; reason?: FailureReason } {
	const task = state.tasks[key];
	if (!task) throw new Refusal("missing", `No task ${key}`);
	if (task.status !== "pending") return task.failureReason ? { status: task.status, reason: task.failureReason } : { status: task.status };
	for (const need of task.needs) {
		const dep = derivedStatus(state, need);
		if (dep.status === "goal_failed") return { status: "goal_failed", reason: "dependency_failed" };
		if (dep.status === "cancelled") return { status: "goal_failed", reason: "dependency_cancelled" };
	}
	if (task.needs.every((need) => state.tasks[need]?.status === "goal_achieved")) return { status: "ready" };
	return { status: "dependency_waiting" };
}

export function isTerminal(status: DerivedStatus): boolean {
	return status === "goal_achieved" || status === "goal_failed" || status === "cancelled";
}

/** The dispatch frontier: at most one ready Task per Worker, and none for a Worker that has one in progress. */
export function readyFrontier(state: TeamState): string[] {
	const busy = new Set(
		Object.values(state.tasks)
			.filter((task) => task.status === "in_progress" || task.status === "blocked")
			.map((task) => task.assignee),
	);
	const chosen = new Map<string, string>();
	for (const key of Object.keys(state.tasks).sort()) {
		const task = state.tasks[key]!;
		if (busy.has(task.assignee) || chosen.has(task.assignee)) continue;
		if (derivedStatus(state, key).status === "ready") chosen.set(task.assignee, key);
	}
	return [...chosen.values()];
}

function checkAcyclic(tasks: Record<string, TaskInput>): void {
	const visiting = new Set<string>();
	const done = new Set<string>();
	const visit = (key: string, path: string[]) => {
		if (done.has(key)) return;
		if (visiting.has(key)) throw new Refusal("invalid_graph", `Dependency cycle: ${[...path, key].join(" → ")}`);
		visiting.add(key);
		for (const need of tasks[key]?.needs ?? []) visit(need, [...path, key]);
		visiting.delete(key);
		done.add(key);
	};
	for (const key of Object.keys(tasks)) visit(key, []);
}

/** Tasks that transitively need `key`, plus `key`. */
function reverseClosure(state: TeamState, key: string): Set<string> {
	const out = new Set([key]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const [k, task] of Object.entries(state.tasks)) {
			if (!out.has(k) && task.needs.some((need) => out.has(need))) {
				out.add(k);
				grew = true;
			}
		}
	}
	return out;
}

function prerequisites(tasks: Record<string, { needs?: string[] }>, key: string): Set<string> {
	const out = new Set<string>();
	const stack = [...(tasks[key]?.needs ?? [])];
	while (stack.length > 0) {
		const next = stack.pop()!;
		if (out.has(next)) continue;
		out.add(next);
		stack.push(...(tasks[next]?.needs ?? []));
	}
	return out;
}

function sameDefinition(a: TaskInput, b: TaskInput): boolean {
	return (
		a.title === b.title &&
		a.goal === b.goal &&
		a.assignee === b.assignee &&
		JSON.stringify([...(a.needs ?? [])].sort()) === JSON.stringify([...(b.needs ?? [])].sort()) &&
		JSON.stringify(a.on_goal_failed ?? null) === JSON.stringify(b.on_goal_failed ?? null)
	);
}

function resetTask(task: Task, now: number, outcome: Attempt["outcome"]): void {
	const current = task.attempts.at(-1);
	if (current && current.endedAt === undefined) {
		current.endedAt = now;
		current.outcome = outcome;
	}
	task.status = "pending";
	delete task.failureReason;
	delete task.evidence;
	bump(task, now);
}

/**
 * `task_graph_apply`: replaces the whole Task set atomically. Unchanged definitions keep their state; changed ones
 * start a new lineage and supersede active Attempts in their reverse closure.
 */
export function applyGraph(
	state: TeamState,
	args: { expected_graph_version?: string; tasks: TaskInput[] },
	now: number,
): { graph_version: string; tasks: string[]; ready_task_ids: string[]; removed: string[] } {
	if (!state.team || state.team.status !== "active") throw new Refusal("no_team", "Create a Team first (team_create).");
	if (state.graphSeq > 0 && args.expected_graph_version !== state.graphVersion)
		throw new Refusal("graph_version_conflict", `Expected graph version ${state.graphVersion}; read it with team_sync.`, {
			current_graph_version: state.graphVersion,
		});
	const incoming: Record<string, TaskInput> = {};
	for (const task of args.tasks) {
		if (!/^[A-Za-z0-9_-]+$/.test(task.key)) throw new Refusal("invalid_graph", `Invalid task key ${task.key}`);
		if (incoming[task.key]) throw new Refusal("invalid_graph", `Duplicate task key ${task.key}`);
		if (!task.title?.trim() || !task.goal?.trim()) throw new Refusal("invalid_graph", `Task ${task.key} needs a title and a goal`);
		if (task.goal.length > 1600) throw new Refusal("invalid_graph", `Task ${task.key}: goal exceeds 1600 characters`);
		const worker = state.workers[task.assignee];
		if (!worker || !worker.membership.active)
			throw new Refusal("worker_unavailable", `Assignee ${task.assignee} is not a current Worker; call ensure_worker first.`);
		incoming[task.key] = { ...task, needs: task.needs ?? [] };
	}
	for (const task of Object.values(incoming)) {
		for (const need of task.needs ?? [])
			if (!incoming[need]) throw new Refusal("invalid_graph", `Task ${task.key} needs unknown task ${need}`);
	}
	checkAcyclic(incoming);
	for (const task of Object.values(incoming)) {
		const edge = task.on_goal_failed;
		if (!edge) continue;
		if (edge.max_traversals < 1 || edge.max_traversals > 8) throw new Refusal("invalid_graph", `${task.key}: max_traversals must be 1..8`);
		if (edge.target !== task.key && !prerequisites(incoming, task.key).has(edge.target))
			throw new Refusal("invalid_graph", `${task.key}: failure target must be the task itself or one of its prerequisites`);
	}
	const removed = Object.keys(state.tasks).filter((key) => !incoming[key]);
	for (const key of removed) {
		const attempt = state.tasks[key]!.attempts.at(-1);
		if (attempt && attempt.endedAt === undefined) {
			attempt.endedAt = now;
			attempt.outcome = "superseded";
		}
		delete state.tasks[key];
	}
	const changed: string[] = [];
	for (const [key, input] of Object.entries(incoming)) {
		const existing = state.tasks[key];
		if (existing && sameDefinition(existing, input)) continue;
		if (existing) changed.push(key);
		state.tasks[key] = {
			key,
			title: input.title,
			goal: input.goal,
			assignee: input.assignee,
			needs: input.needs ?? [],
			...(input.on_goal_failed ? { on_goal_failed: input.on_goal_failed } : {}),
			status: "pending",
			current_context: existing?.current_context ?? "Work has not started.",
			version: "",
			versionSeq: existing?.versionSeq ?? 0,
			attempts: existing?.attempts ?? [],
			traversals: 0,
			updatedAt: now,
		};
		bump(state.tasks[key]!, now);
	}
	for (const key of changed) {
		for (const dependent of reverseClosure(state, key)) {
			if (dependent === key) continue;
			const task = state.tasks[dependent]!;
			if (task.status !== "pending" && task.status !== "cancelled") resetTask(task, now, "superseded");
		}
	}
	state.graphSeq += 1;
	state.graphVersion = `g_${state.graphSeq}`;
	return { graph_version: state.graphVersion, tasks: Object.keys(state.tasks), ready_task_ids: readyFrontier(state), removed };
}

export type Transition = "claim" | "block" | "resume" | "goal_achieved" | "goal_failed" | "cancel";

/** `task_update`: one versioned transition by one actor (a Worker name, or `team-lead`). */
export function updateTask(
	state: TeamState,
	actor: string,
	args: { task_id: string; expected_version: string; transition?: Transition; current_context?: string; evidence?: string },
	now: number,
): { task: Task; status: DerivedStatus; event?: TeamEvent["kind"]; traversal?: string; ready_task_ids: string[] } {
	const task = state.tasks[args.task_id];
	if (!task) throw new Refusal("missing", `No task ${args.task_id}`);
	if (task.version !== args.expected_version)
		throw new Refusal("version_conflict", `Task ${task.key} is at ${task.version}; re-read it with task_read.`, { current_version: task.version });
	if (args.current_context !== undefined && args.current_context.length > 2000)
		throw new Refusal("invalid", "current_context exceeds 2000 characters");
	const status = derivedStatus(state, task.key).status;
	const needsEvidence = (t: Transition) => t === "block" || t === "goal_achieved" || t === "goal_failed" || t === "cancel";
	let event: TeamEvent["kind"] | undefined;
	let traversal: string | undefined;
	if (args.transition) {
		const t = args.transition;
		if (needsEvidence(t) && !args.evidence?.trim()) throw new Refusal("evidence_required", `${t} requires evidence`);
		if (t === "cancel") {
			if (actor !== LEAD) throw new Refusal("worker_mismatch", "Only the lead cancels Tasks");
			if (isTerminal(status)) throw new Refusal("invalid_transition", `Task is ${status}`);
			const attempt = task.attempts.at(-1);
			if (attempt && attempt.endedAt === undefined) Object.assign(attempt, { endedAt: now, outcome: "cancelled", evidence: args.evidence });
			task.status = "cancelled";
			task.evidence = args.evidence;
			event = "task_cancelled";
		} else {
			if (actor !== task.assignee) throw new Refusal("worker_mismatch", `Task ${task.key} is assigned to ${task.assignee}`);
			if (t === "claim" || t === "resume") {
				const expected = t === "claim" ? "ready" : "blocked";
				if (status !== expected) throw new Refusal("invalid_transition", `Cannot ${t} a task that is ${status}`);
				const occupied = Object.values(state.tasks).find(
					(other) => other.key !== task.key && other.assignee === actor && (other.status === "in_progress" || other.status === "blocked"),
				);
				if (occupied) throw new Refusal("worker_occupied", `${actor} already holds ${occupied.key}`, { current_task: occupied.key });
				if (t === "claim") {
					const ordinal = task.attempts.length + 1;
					task.attempts.push({ id: `${task.key}@${ordinal}`, ordinal, startedAt: now });
					event = "task_claimed";
				} else event = "task_resumed";
				task.status = "in_progress";
			} else if (t === "block") {
				if (status !== "in_progress") throw new Refusal("invalid_transition", `Cannot block a task that is ${status}`);
				task.status = "blocked";
				task.evidence = args.evidence;
				event = "task_blocked";
			} else {
				if (status !== "in_progress") throw new Refusal("invalid_transition", `Cannot report ${t} for a task that is ${status}`);
				const attempt = task.attempts.at(-1);
				if (attempt) Object.assign(attempt, { endedAt: now, outcome: t, evidence: args.evidence });
				task.evidence = args.evidence;
				if (t === "goal_achieved") {
					task.status = "goal_achieved";
					event = "task_goal_achieved";
				} else {
					event = "task_goal_failed";
					const edge = task.on_goal_failed;
					if (edge && task.traversals < edge.max_traversals && state.tasks[edge.target]?.status !== "cancelled") {
						task.traversals += 1;
						traversal = edge.target;
						for (const key of reverseClosure(state, edge.target)) {
							const affected = state.tasks[key]!;
							if (prerequisites(state.tasks, task.key).has(key) || key === task.key || key === edge.target) {
								resetTask(affected, now, "superseded");
							}
						}
					} else {
						task.status = "goal_failed";
						task.failureReason = edge ? "failure_edge_exhausted" : "criterion_failed";
					}
				}
			}
		}
	}
	if (args.current_context !== undefined) {
		task.current_context = args.current_context;
		event ??= "task_context_updated";
	}
	if (!event) throw new Refusal("invalid", "Nothing to update: give a transition or current_context");
	bump(task, now);
	return { task, status: derivedStatus(state, task.key).status, event, ...(traversal ? { traversal } : {}), ready_task_ids: readyFrontier(state) };
}

/** A Task card as tools return it: authored fields plus the derived status. */
export function card(state: TeamState, key: string) {
	const task = state.tasks[key]!;
	const derived = derivedStatus(state, key);
	return {
		task_id: task.key,
		title: task.title,
		goal: task.goal,
		assignee: task.assignee,
		needs: task.needs,
		...(task.on_goal_failed ? { on_goal_failed: task.on_goal_failed } : {}),
		status: derived.status,
		...(derived.reason ? { reason: derived.reason } : {}),
		version: task.version,
		current_context: task.current_context,
		...(task.evidence ? { evidence: task.evidence } : {}),
		attempts: task.attempts.length,
		current_attempt: task.attempts.at(-1)?.endedAt === undefined ? task.attempts.at(-1)?.id : undefined,
	};
}
