// Team (Pi Team Bright semantics) in the AmPi node: installs the durable-team extensions, labels lead and Worker
// threads in the index, and publishes the Team authority to clients as a read-only topic (C5: no liveness claims;
// clients join Worker activity from the thread index themselves).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { TeamCore, TeamDoc, TeamLead, TeamWorker, type TeamState } from "@hypercarrier/durable-team";
import { derivedStatus } from "@hypercarrier/durable-team/graph";
import type { JsonValue } from "@earendil-works/chord";
import { NodeError, type NodePlugin, parseThreadKey } from "../node/runtime.ts";
import { fromState, type TopicSource, topics } from "../node/server.ts";

/** Team state with derived statuses, as the Team panel draws it. */
export function teamView(state: TeamState | undefined, storeId: string): JsonValue {
	if (!state?.team) return { team: null } as JsonValue;
	const tasks = Object.values(state.tasks).map((task) => {
		const derived = derivedStatus(state, task.key);
		return { ...task, derived: derived.status, ...(derived.reason ? { derivedReason: derived.reason } : {}) };
	});
	const workers = Object.values(state.workers).map((w) => ({ ...w, threadId: `${storeId}.${w.membership.conversationId}` }));
	return {
		team: state.team,
		leadThreadId: `${storeId}.${state.team.leadConversationId}`,
		graphVersion: state.graphVersion,
		workers,
		tasks,
		events: state.events.slice(-80),
		alerts: state.alerts.slice(-30),
		deliveries: Object.values(state.deliveries).slice(-60),
	} as unknown as JsonValue;
}

export function teamPlugin(): NodePlugin {
	topics.set("team", async (topic, runtime) => {
		if (topic.kind !== "team") throw new NodeError("bad_request", "team topic");
		const { storeId } = parseThreadKey(topic.teamId);
		const store = runtime.store(storeId);
		const state = await store.harness.documentState(TeamDoc, BACKGROUND_CONTEXT);
		if (state) return fromState(state, (value) => teamView(value as TeamState | undefined, storeId));
		// No Team yet: publish an empty view and attach once a commit creates the document.
		let current: JsonValue = teamView(undefined, storeId);
		let inner: TopicSource | undefined;
		let stopInner: (() => void) | undefined;
		const listeners = new Set<(value: JsonValue) => void>();
		let attaching = false;
		const stopCommits = store.harness.subscribeCommits((publication) => {
			if (inner || attaching) return;
			if (!publication.changes.some((c) => c.type === "document" && c.conversationId === undefined)) return;
			attaching = true;
			setTimeout(async () => {
				const attached = await store.harness.documentState(TeamDoc, BACKGROUND_CONTEXT).catch(() => undefined);
				attaching = false;
				if (!attached || inner) return;
				inner = fromState(attached, (value) => teamView(value as TeamState | undefined, storeId));
				current = inner.value;
				for (const listener of listeners) listener(current);
				stopInner = inner.subscribe((value) => {
					current = value;
					for (const listener of listeners) listener(value);
				});
				stopCommits();
			}, 0);
		});
		return {
			get value() {
				return current;
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			dispose() {
				stopCommits();
				stopInner?.();
				inner?.dispose?.();
			},
		} satisfies TopicSource;
	});
	return {
		extensions: [TeamCore, TeamLead, TeamWorker],
		optIn: [TeamWorker],
		touches(kind, value) {
			if (kind !== TeamDoc.definition.kind) return [];
			const state = value as TeamState | null;
			return state?.team ? [state.team.leadConversationId, ...Object.values(state.workers).map((w) => w.membership.conversationId)].map(String) : [];
		},
		async summarize(store, conversationId, summary) {
			const state = (await store.harness.snapshot(TeamDoc, BACKGROUND_CONTEXT)) as TeamState | undefined;
			if (!state?.team) return;
			if (state.team.leadConversationId === conversationId) {
				summary.team = { teamId: store.threadKey(conversationId), role: "lead" };
				// Task-authority facts that need the lead's owner, independent of any Rarebit judgment (P5).
				const attention: { source: string; reason: string }[] = [];
				for (const task of Object.values(state.tasks)) {
					const { status, reason } = derivedStatus(state, task.key);
					if (status === "blocked") attention.push({ source: "Team", reason: `Task ${task.key} blocked` });
					else if (status === "goal_failed" && !String(reason ?? "").startsWith("dependency")) attention.push({ source: "Team", reason: `Task ${task.key} failed` });
				}
				if (attention.length && state.team.status === "active") summary.attention = [...(summary.attention ?? []), ...attention];
				return;
			}
			for (const worker of Object.values(state.workers)) {
				if (worker.membership.conversationId !== conversationId) continue;
				summary.kind = "worker";
				summary.team = { teamId: store.threadKey(state.team.leadConversationId), role: "worker", worker: worker.name };
				if (!summary.title || summary.title === "New thread" || summary.title.startsWith("[Team")) summary.title = worker.scope;
			}
		},
	};
}
