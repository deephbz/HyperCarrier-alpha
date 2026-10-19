// Pi Team Bright, adapted to pi-durable. A Team lives in the lead thread's storage:
// - the Task authority is one Session document (TeamDoc), changed only inside tool commits;
// - each Worker is a child conversation owned by a background anchor task (a durable subthread that outlives the
//   lead's turns and Esc), so a crash resumes it with the same transcript (P4: one Worker = one conversation);
// - every accepted change that must reach an agent is written as a Delivery in the same commit as the change, and a
//   background Deliver task then submits it with an idempotent request ID (P7: acceptance before actuation; the
//   delivery is a separate, retried, recorded fact). Notices are placed as `team.notice` entries, never as human input.
// The Herdr-era delivery hold (C1) is not needed: pi-durable places steers and follow-ups only at turn boundaries.

import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	LiveDoc,
	type ToolExecutionApi,
	type Tx,
} from "@earendil-works/pi-durable";
import {
	type Alert,
	applyGraph,
	card,
	type Delivery,
	derivedStatus,
	initialTeamState,
	isTerminal,
	LEAD,
	pushAlert,
	pushDelivery,
	readyFrontier,
	record,
	Refusal,
	type TeamState,
	type Transition,
	updateTask,
} from "./graph.ts";

export const TeamDoc = defineDoc<TeamState>({
	kind: "team.state",
	version: 1,
	scope: "session",
	initial: initialTeamState,
});

export const NOTICE_KIND = "team.notice";

// ─── Tasks: worker anchor and delivery ──────────────────────────────────────

const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "team.worker-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type DeliverInput = {
	deliveryId: string;
	conversationId: number;
	content: string;
	title: string;
	summary: string;
	whenBusy: "steer" | "followUp";
	refs: string[];
	acceptedAt: number;
};

function draft(input: DeliverInput) {
	return {
		type: "input",
		content: input.content,
		whenBusy: input.whenBusy,
		requestId: `team:${input.deliveryId}`,
		entry: {
			kind: NOTICE_KIND,
			data: { source: "team", title: input.title, summary: input.summary, refs: input.refs, deliveryId: input.deliveryId, ts: input.acceptedAt },
		},
	} as const;
}

/** Submits one accepted change to its recipient, then records how the recipient settled it. Restart-safe. */
const Deliver = defineTask<DeliverInput, { phase: "submit" } | { phase: "settle"; submissionId: string }, null>({
	name: "team.deliver",
	version: 1,
	initial: () => ({ phase: "submit" }),
	phases: {
		submit: async (task, runtime, context) => {
			const input = task.input;
			const target = await runtime.conversation(input.conversationId as ConversationId, context);
			if (!target) {
				await runtime.commit(async (tx) => {
					const state = await tx.doc(TeamDoc);
					const delivery = state.deliveries[input.deliveryId];
					if (delivery) Object.assign(delivery, { settledAt: Date.now(), settled: "recipient_missing" });
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context);
				return;
			}
			const submission = await target.submit(draft(input), context);
			await runtime.commit(async (tx) => {
				const state = await tx.doc(TeamDoc);
				const delivery = state.deliveries[input.deliveryId];
				if (delivery) Object.assign(delivery, { submittedAt: Date.now(), submissionId: String(submission.id) });
				record(state, { kind: "delivery_submitted", actor: "authority", detail: `${input.deliveryId} → ${delivery?.to ?? "?"}` }, Date.now());
				return { status: "running", checkpoint: { phase: "settle", submissionId: String(submission.id) } };
			}, context);
		},
		settle: async (task, runtime, context) => {
			// Re-submitting with the same request ID returns the admitted submission; waiting on it is restart-safe.
			const target = await runtime.conversation(task.input.conversationId as ConversationId, context);
			const settled = target ? await (await target.submit(draft(task.input), context)).wait(context) : undefined;
			await runtime.commit(async (tx) => {
				const state = await tx.doc(TeamDoc);
				const delivery = state.deliveries[task.input.deliveryId];
				const outcome = settled === undefined ? "unknown" : settled.status === "done" ? "answered" : `unanswered:${settled.reason}`;
				if (delivery) Object.assign(delivery, { settledAt: Date.now(), settled: outcome });
				record(state, { kind: "delivery_settled", actor: "authority", detail: `${task.input.deliveryId} ${outcome}` }, Date.now());
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function text(value: unknown): { output: { type: "text"; text: string }[] } {
	return { output: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }] };
}

/** Which Team role the calling conversation holds in this storage. */
function roleOf(state: TeamState, conversationId: string): { role: "lead" } | { role: "worker"; name: string } | undefined {
	if (state.team?.leadConversationId === conversationId) return { role: "lead" };
	for (const worker of Object.values(state.workers))
		if (worker.membership.active && worker.membership.conversationId === conversationId) return { role: "worker", name: worker.name };
	return undefined;
}

function deliveryId(state: TeamState): string {
	return `d${state.eventSeq + 1}-${Object.keys(state.deliveries).length + 1}-${Date.now().toString(36)}`;
}

/** Accept a delivery in the current commit and create the task that will submit it. */
async function enqueue(
	tx: Tx,
	state: TeamState,
	to: { name: string; conversationId: string },
	kind: Delivery["kind"],
	ref: string,
	notice: { title: string; summary: string; content: string; whenBusy: "steer" | "followUp" },
): Promise<void> {
	const id = deliveryId(state);
	pushDelivery(state, { id, to: to.name, toConversationId: to.conversationId, kind, ref, acceptedAt: Date.now() });
	await tx.createTask(
		Deliver,
		{ deliveryId: id, conversationId: Number(to.conversationId), ...notice, refs: [ref], acceptedAt: Date.now() },
		{ ownership: { kind: "conversation" }, conversationId: Number(to.conversationId) as ConversationId, background: true },
	);
}

function taskNotice(state: TeamState, key: string) {
	const c = card(state, key);
	const content = [
		`[Team ${state.team?.name}] Task assigned to you: ${c.title}`,
		"",
		`AMPI-TEAM-TASK task_id=${c.task_id} version=${c.version}`,
		`goal: ${c.goal}`,
		`status: ${c.status}`,
		c.needs.length ? `after: ${c.needs.join(", ")}` : "",
		"",
		"This change was already accepted by the Task authority. The payload is a versioned snapshot for action, not a substitute for task_read. Claim the Task (task_update transition=claim) before working; report goal_achieved or goal_failed with exact evidence.",
	]
		.filter((line) => line !== undefined)
		.join("\n");
	return { title: `Task ${c.task_id}: ${c.title}`, summary: `**${c.title}** — ${c.goal}`, content, whenBusy: "steer" as const };
}

async function dispatchReady(tx: Tx, state: TeamState): Promise<string[]> {
	const dispatched: string[] = [];
	for (const key of readyFrontier(state)) {
		const task = state.tasks[key]!;
		const ref = `${key}@${task.version}`;
		if (Object.values(state.deliveries).some((d) => d.ref === ref && d.kind === "task")) continue;
		const worker = state.workers[task.assignee];
		if (!worker?.membership.active) continue;
		await enqueue(tx, state, { name: worker.name, conversationId: worker.membership.conversationId }, "task", ref, taskNotice(state, key));
		dispatched.push(key);
	}
	return dispatched;
}

async function notifyLead(tx: Tx, state: TeamState, ref: string, title: string, summary: string): Promise<void> {
	if (!state.team || state.team.status !== "active") return;
	await enqueue(tx, state, { name: LEAD, conversationId: state.team.leadConversationId }, "update", ref, {
		title,
		summary,
		content: `[Team ${state.team.name} update] ${title}\n\n${summary}\n\nAMPI-TEAM-UPDATE\nCall team_sync for the current Task graph before acting. Wait by ending your turn; updates arrive on their own.`,
		whenBusy: "followUp",
	});
}

function refusal(error: unknown) {
	if (error instanceof Refusal) return { ...text({ result: "refused", reason: error.reason, message: error.message, ...error.extra }), isError: true };
	throw error;
}

/** Values leaving a commit must not alias the document draft, which is unusable once the commit settles. */
function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** JSON round-trip at the receipt boundary: drops `undefined` members, so the result is a plain JsonValue. */
function toJson(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function fingerprint(args: unknown): string {
	return JSON.stringify(args);
}

const WORKER_PROMPT = (team: string, worker: string, scope: string) =>
	[
		`You are Worker '${worker}' on Team '${team}'. Your lead is '${LEAD}'. Your standing Worker profile: ${scope}`,
		"",
		"Assigned Tasks are your work contracts and arrive as Team notices; presentation never changes Task state. Waiting and ready are derived by the Task authority.",
		"Claim a ready Task (task_update transition=claim) before work. When the goal passes its external criteria, call task_update with goal_achieved and exact evidence. Use goal_failed when the criteria fail. Use block only for an external blocker, with blocker evidence, and resume when it clears.",
		"Use alert_send only for exceptional clarification or attention the lead must see. Re-read Task authority (task_read) before a conflicting write. When you have no Task, end your turn and wait.",
	].join("\n");

// ─── Tools ──────────────────────────────────────────────────────────────────

const TaskInputSchema = Type.Object({
	key: Type.String({ description: "Stable task id: letters, digits, _ and -" }),
	title: Type.String(),
	goal: Type.String({ description: "Externally checkable completion criteria (max 1600 chars)" }),
	assignee: Type.String({ description: "A current Worker name" }),
	needs: Type.Optional(Type.Array(Type.String(), { description: "Task keys that must achieve their goal first" })),
	on_goal_failed: Type.Optional(
		Type.Object({ target: Type.String(), max_traversals: Type.Number({ minimum: 1, maximum: 8 }) }, { description: "Repair edge: on failure, reopen target (this task or a prerequisite)" }),
	),
});

async function readState(api: ToolExecutionApi, context: Context): Promise<TeamState> {
	return ((await api.snapshot(TeamDoc, context)) as TeamState | undefined) ?? initialTeamState();
}

const teamCreate = defineTool({
	name: "team_create",
	description:
		"Create a Team led by this thread. Workers become durable subthreads; their Task graph is the Team's only Task authority. One active Team per lead thread.",
	parameters: Type.Object({ name: Type.String(), purpose: Type.String() }),
	execute: async (args, api, context) => {
		try {
			const result = await api.commit(async (tx) => {
				const state = await tx.doc(TeamDoc);
				if (state.team?.status === "active") throw new Refusal("active_team_exists", `Team ${state.team.name} is already active here.`);
				if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.name)) throw new Refusal("name_unavailable", "Use 1-64 letters, digits, _ or -.");
				state.team = { name: args.name, purpose: args.purpose, createdAt: Date.now(), status: "active", leadConversationId: String(api.conversationId) };
				record(state, { kind: "team_created", actor: LEAD, detail: args.purpose }, Date.now());
				return { result: "team_created", team: args.name };
			}, context);
			return text(result);
		} catch (error) {
			return refusal(error);
		}
	},
});

function ensureWorkerTool(workerExtension: () => Extension, leadExtension: () => Extension) {
	return defineTool({
		name: "ensure_worker",
		description:
			"Create or reuse a stable Worker (a durable subthread with its own transcript). Scope is the Worker's standing area of work, not a Task. Assign work with task_graph_apply.",
		parameters: Type.Object({
			name: Type.String(),
			scope: Type.String(),
			model: Type.Optional(Type.String({ description: "provider/modelId for this Worker; default: the lead's model" })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			try {
				const result = await api.commit(async (tx) => {
					const state = await tx.doc(TeamDoc);
					if (!state.team || state.team.status !== "active") throw new Refusal("no_team", "Create a Team first (team_create).");
					if (roleOf(state, String(api.conversationId))?.role !== "lead") throw new Refusal("not_lead", "Only the lead ensures Workers.");
					if (!/^[A-Za-z0-9_-]{1,40}$/.test(args.name) || args.name === LEAD) throw new Refusal("invalid_name", "Use 1-40 letters, digits, _ or -.");
					const existing = state.workers[args.name];
					if (existing) {
						if (existing.scope.trim() !== args.scope.trim() && existing.membership.active)
							throw new Refusal("name_scope_conflict", `${args.name} exists with scope: ${existing.scope}`);
						if (existing.membership.active) return { result: "worker_ensured", effect: "reused", worker: args.name, conversationId: existing.membership.conversationId };
					}
					const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
					const [provider, ...rest] = (args.model ?? "").split("/");
					await configure(tx, child.id, {
						extensions: { remove: [leadExtension()], add: [workerExtension()] },
						instructions: WORKER_PROMPT(state.team.name, args.name, args.scope),
						...(args.model && rest.length ? { model: { provider: provider!, modelId: rest.join("/") } } : {}),
					});
					const generation = (existing?.membership.generation ?? 0) + 1;
					state.workers[args.name] = {
						name: args.name,
						scope: args.scope,
						createdAt: existing?.createdAt ?? Date.now(),
						membership: { id: `${args.name}#${generation}`, generation, conversationId: String(child.id), active: true },
					};
					record(state, { kind: "worker_ensured", actor: LEAD, worker: args.name, detail: existing ? "recreated" : "created" }, Date.now());
					// A recreated Worker gets its ready Task again.
					await dispatchReady(tx, state);
					return { result: "worker_ensured", effect: existing ? "recreated" : "created", worker: args.name, conversationId: String(child.id) };
				}, context);
				await api.details({ conversationId: result.conversationId, worker: args.name }, context);
				return text(result);
			} catch (error) {
				return refusal(error);
			}
		},
	});
}

const taskGraphApply = defineTool({
	name: "task_graph_apply",
	description:
		"Atomically replace the Team's whole Task set (omitted tasks are removed). Unchanged definitions keep their progress. Ready tasks are delivered to their Workers. Pass expected_graph_version from the previous result after the first apply.",
	parameters: Type.Object({
		operation_id: Type.String({ description: "Idempotency key: retrying the same operation returns the first result" }),
		expected_graph_version: Type.Optional(Type.String()),
		tasks: Type.Array(TaskInputSchema),
	}),
	execute: async (args, api, context) => {
		try {
			const result = await api.commit(async (tx) => {
				const state = await tx.doc(TeamDoc);
				if (roleOf(state, String(api.conversationId))?.role !== "lead") throw new Refusal("not_lead", "Only the lead applies the Task graph.");
				const receipt = state.receipts[`graph:${args.operation_id}`];
				if (receipt) {
					if (receipt.fingerprint !== fingerprint(args)) throw new Refusal("operation_conflict", "operation_id was used with different input");
					return { ...plain(receipt.result as object), replayed: true };
				}
				const applied = applyGraph(state, args, Date.now());
				record(state, { kind: "graph_applied", actor: LEAD, detail: `${applied.graph_version}: ${applied.tasks.length} tasks` }, Date.now());
				const dispatched = await dispatchReady(tx, state);
				const out = {
					result: "task_graph_applied",
					graph_version: applied.graph_version,
					tasks_by_key: Object.fromEntries(applied.tasks.map((key) => [key, { status: derivedStatus(state, key).status, version: state.tasks[key]!.version }])),
					ready_task_ids: applied.ready_task_ids,
					delivered_to_workers: dispatched,
					...(applied.removed.length ? { removed: applied.removed } : {}),
				};
				state.receipts[`graph:${args.operation_id}`] = { fingerprint: fingerprint(args), result: toJson(out) };
				return plain(out);
			}, context);
			return text(result);
		} catch (error) {
			return refusal(error);
		}
	},
});

const taskRead = defineTool({
	name: "task_read",
	description: "Read Task cards (status, version, goal, current_context, evidence) from the Task authority.",
	parameters: Type.Object({ task_ids: Type.Array(Type.String()) }),
	execute: async (args, api, context) => {
		const state = await readState(api, context);
		return text({ result: "task_read_batch", outcomes: args.task_ids.map((id) => (state.tasks[id] ? { found: card(state, id) } : { missing: id })) });
	},
});

const taskUpdate = defineTool({
	name: "task_update",
	description:
		"Record one Task transition (claim, block, resume, goal_achieved, goal_failed, cancel) and/or replace current_context. Requires the card's current version. Evidence is required for block, goal_achieved, goal_failed and cancel.",
	parameters: Type.Object({
		task_id: Type.String(),
		expected_version: Type.String(),
		transition: Type.Optional(
			Type.Union([
				Type.Literal("claim"),
				Type.Literal("block"),
				Type.Literal("resume"),
				Type.Literal("goal_achieved"),
				Type.Literal("goal_failed"),
				Type.Literal("cancel"),
			]),
		),
		current_context: Type.Optional(Type.String()),
		evidence: Type.Optional(Type.String()),
		operation_id: Type.Optional(Type.String()),
	}),
	execute: async (args, api, context) => {
		try {
			const result = await api.commit(async (tx) => {
				const state = await tx.doc(TeamDoc);
				const role = roleOf(state, String(api.conversationId));
				if (!role) throw new Refusal("not_member", "This thread is not a current member of this Team.");
				const actor = role.role === "lead" ? LEAD : role.name;
				if (args.operation_id) {
					const receipt = state.receipts[`task:${args.operation_id}`];
					if (receipt) {
						if (receipt.fingerprint !== fingerprint(args)) throw new Refusal("operation_conflict", "operation_id was used with different input");
						return { ...plain(receipt.result as object), replayed: true };
					}
				}
				const updated = updateTask(state, actor, { ...args, transition: args.transition as Transition | undefined }, Date.now());
				record(state, { kind: updated.event!, actor, task: args.task_id, detail: args.evidence?.slice(0, 300) ?? args.transition }, Date.now());
				if (updated.traversal) record(state, { kind: "failure_edge_traversed", actor, task: args.task_id, detail: `reopened ${updated.traversal}` }, Date.now());
				await dispatchReady(tx, state);
				const status = derivedStatus(state, args.task_id).status;
				if (actor !== LEAD && (isTerminal(status) || status === "blocked" || updated.traversal)) {
					await notifyLead(
						tx,
						state,
						`${args.task_id}@${state.tasks[args.task_id]!.version}`,
						`${args.task_id} ${updated.traversal ? `failed; reopened ${updated.traversal}` : status} (${actor})`,
						args.evidence ? `Evidence: ${args.evidence.slice(0, 1200)}` : "",
					);
				}
				const out = { result: "updated", task: card(state, args.task_id), ready_task_ids: updated.ready_task_ids, ...(updated.traversal ? { failure_traversal: updated.traversal } : {}) };
				if (args.operation_id) state.receipts[`task:${args.operation_id}`] = { fingerprint: fingerprint(args), result: toJson(out) };
				return plain(out);
			}, context);
			return text(result);
		} catch (error) {
			return refusal(error);
		}
	},
});

const teamSync = defineTool({
	name: "team_sync",
	description:
		"Read the Team now: Workers (with whether their subthread is working), Tasks, and recent Alerts (snapshot), or only what changed since your last sync (updates). Returns immediately; never poll it in a loop — end your turn to wait.",
	parameters: Type.Object({ view: Type.Optional(Type.Union([Type.Literal("snapshot"), Type.Literal("updates")])) }),
	execute: async (args, api, context) => {
		const state = await readState(api, context);
		if (!state.team) return text({ result: "unavailable", reason: "no_team" });
		const workers = [];
		for (const worker of Object.values(state.workers)) {
			const live = await api.snapshot(LiveDoc, Number(worker.membership.conversationId) as ConversationId, context);
			workers.push({
				name: worker.name,
				scope: worker.scope,
				membership: worker.membership.active ? "current" : `ended (${worker.membership.deactivationReason ?? "stopped"})`,
				run_state: live?.run ? "working" : "settled",
				nonterminal_task_ids: Object.values(state.tasks)
					.filter((t) => t.assignee === worker.name && !isTerminal(derivedStatus(state, t.key).status))
					.map((t) => t.key),
			});
		}
		const since = args.view === "updates" ? state.syncCursor : 0;
		const changes = state.events.filter((e) => e.seq > since && e.kind !== "delivery_submitted" && e.kind !== "delivery_settled");
		await api.commit(async (tx) => {
			(await tx.doc(TeamDoc)).syncCursor = state.eventSeq;
		}, context);
		if (args.view === "updates")
			return text(changes.length === 0 ? { result: "caught_up" } : { result: "updates", changes, tasks: Object.keys(state.tasks).map((k) => card(state, k)) });
		return text({
			result: "snapshot",
			team: state.team,
			graph_version: state.graphVersion,
			workers,
			tasks: Object.keys(state.tasks).map((k) => card(state, k)),
			alerts: state.alerts.slice(-10).map((a) => ({ ...a, text: a.text.slice(0, 2000) })),
		});
	},
});

const alertSend = defineTool({
	name: "alert_send",
	description:
		"Send an exceptional Alert: Workers always reach the lead; the lead addresses one Worker or '*' (announcement). An Alert never assigns, advances, blocks, or completes a Task.",
	parameters: Type.Object({
		to: Type.Optional(Type.String({ description: "Lead only: a Worker name or '*'" })),
		kind: Type.Union([Type.Literal("clarification"), Type.Literal("attention"), Type.Literal("announcement")]),
		text: Type.String(),
		task_id: Type.Optional(Type.String()),
	}),
	execute: async (args, api, context) => {
		try {
			const result = await api.commit(async (tx) => {
				const state = await tx.doc(TeamDoc);
				const role = roleOf(state, String(api.conversationId));
				if (!state.team || !role) throw new Refusal("not_member", "This thread is not a current member of an active Team.");
				const from = role.role === "lead" ? LEAD : role.name;
				let recipients: { name: string; conversationId: string }[];
				if (role.role === "worker") recipients = [{ name: LEAD, conversationId: state.team.leadConversationId }];
				else if (args.to === "*") {
					if (args.kind !== "announcement") throw new Refusal("invalid", "'*' is only for announcements");
					recipients = Object.values(state.workers)
						.filter((w) => w.membership.active)
						.map((w) => ({ name: w.name, conversationId: w.membership.conversationId }));
				} else {
					const worker = args.to ? state.workers[args.to] : undefined;
					if (!worker?.membership.active)
						throw new Refusal("recipient_not_current", `${args.to ?? "(none)"} is not a current member; nothing was written.`);
					recipients = [{ name: worker.name, conversationId: worker.membership.conversationId }];
				}
				const alert: Alert = { id: `a${state.alerts.length + 1}-${Date.now().toString(36)}`, ts: Date.now(), from, to: args.to ?? LEAD, kind: args.kind, text: args.text, ...(args.task_id ? { task_id: args.task_id } : {}) };
				pushAlert(state, alert);
				record(state, { kind: "alert_sent", actor: from, task: args.task_id, detail: `${args.kind} → ${alert.to}` }, Date.now());
				for (const recipient of recipients) {
					await enqueue(tx, state, recipient, "alert", alert.id, {
						title: `${args.kind} alert from ${from}`,
						summary: args.text.slice(0, 1200),
						content: `[Team ${state.team.name} ${args.kind} Alert ${alert.id} from ${from}] ${args.text}\n\nThis Alert is exceptional coordination only. It does not assign, advance, block, or complete a Task.`,
						whenBusy: args.kind === "attention" ? "steer" : "followUp",
					});
				}
				return plain({ result: "alert_sent", alert_id: alert.id, accepted_recipients: recipients.map((r) => r.name), note: "stored and queued for delivery, not yet presented" });
			}, context);
			return text(result);
		} catch (error) {
			return refusal(error);
		}
	},
});

const workerStop = defineTool({
	name: "worker_stop",
	description: "Stop a Worker: aborts its subthread's work and ends its Membership. Refused while it holds nonterminal Tasks.",
	parameters: Type.Object({ worker: Type.String() }),
	execute: async (args, api, context) => {
		try {
			const state = await readState(api, context);
			if (roleOf(state, String(api.conversationId))?.role !== "lead") throw new Refusal("not_lead", "Only the lead stops Workers.");
			const worker = state.workers[args.worker];
			if (!worker?.membership.active) throw new Refusal("missing", `${args.worker} is not a current Worker`);
			const guarding = Object.values(state.tasks).filter((t) => t.assignee === args.worker && !isTerminal(derivedStatus(state, t.key).status));
			if (guarding.length) throw new Refusal("nonterminal_tasks_assigned", "Cancel or reassign its Tasks first.", { guarding_task_ids: guarding.map((t) => t.key) });
			await (await api.conversation(Number(worker.membership.conversationId) as ConversationId, context))?.abort(context);
			await api.commit(async (tx) => {
				const s = await tx.doc(TeamDoc);
				Object.assign(s.workers[args.worker]!.membership, { active: false, deactivationReason: "stopped_by_lead" });
				record(s, { kind: "worker_stopped", actor: LEAD, worker: args.worker }, Date.now());
			}, context);
			return text({ result: "worker_stopped", worker: args.worker });
		} catch (error) {
			return refusal(error);
		}
	},
});

const teamShutdown = defineTool({
	name: "team_shutdown",
	description: "Stop every Worker and end the Team. Tasks and history are kept.",
	parameters: Type.Object({}),
	execute: async (_args, api, context) => {
		try {
			const state = await readState(api, context);
			if (roleOf(state, String(api.conversationId))?.role !== "lead") throw new Refusal("not_lead", "Only the lead shuts the Team down.");
			for (const worker of Object.values(state.workers))
				if (worker.membership.active) await (await api.conversation(Number(worker.membership.conversationId) as ConversationId, context))?.abort(context);
			await api.commit(async (tx) => {
				const s = await tx.doc(TeamDoc);
				for (const worker of Object.values(s.workers))
					if (worker.membership.active) Object.assign(worker.membership, { active: false, deactivationReason: "team_shutdown" });
				if (s.team) s.team.status = "stopped";
				record(s, { kind: "team_shutdown", actor: LEAD }, Date.now());
			}, context);
			return text({ result: "team_shutdown" });
		} catch (error) {
			return refusal(error);
		}
	},
});

const LEAD_GUIDE = `You can lead a Team of Workers (durable subthreads) with the team tools. Use them when work splits into parallel, separately verifiable Tasks.
- team_create once, ensure_worker per standing area of work, then task_graph_apply with the whole Task set (each revision replaces the set).
- Workers establish facts; you form opinions. Notices about finished, failed, or blocked Tasks arrive on their own as Team updates: wait by ending your turn, never by sleeping or polling team_sync.
- caught_up does not mean every Task succeeded; read the cards.`;

let leadRef: Extension;
let workerRef: Extension;

/** Tools of a lead (and of any thread that may become one). */
/** Task definitions shared by leads and Workers; selected everywhere so deliveries resume after a restart. */
export const TeamCore: Extension = defineExtension({ name: "team-core", tasks: [Anchor, Deliver] });

export const TeamLead: Extension = (leadRef = defineExtension({
	name: "team-lead",
	sections: [{ key: "team", render: () => LEAD_GUIDE }],
	tools: [teamCreate, ensureWorkerTool(() => workerRef, () => leadRef), taskGraphApply, taskRead, taskUpdate, teamSync, alertSend, workerStop, teamShutdown],
}));

/** Tools of a Worker subthread: read and advance its own Tasks, and alert the lead. */
export const TeamWorker: Extension = (workerRef = defineExtension({
	name: "team-worker",
	tools: [taskRead, taskUpdate, alertSend],
}));
