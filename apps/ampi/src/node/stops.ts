// The node's stop fence: one interface for every stored stop decision (thread Close, and plugin stops such as Team
// Worker anchors, deliveries, and notifiers). The owner of a stop commits its intent first. The node then marks the
// work without joining live invocations. The caller can bound its wait for settlement.
// On open, every stored intent is marked before `harness.resume()`, so a kill between intent and abort cannot leave
// work running behind a stop (node-design.md, Close; review-design-systems.md, close recovery).

import { type Context, withCancel } from "@earendil-works/chord/context";
import { type ConversationId, type Harness, InboxDoc, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import type { ControlSubmission } from "../shared/protocol.ts";
import { contentText, countImages, queueOrigin } from "./projection.ts";

/**
 * A stored stop decision. `conversations`: fence each one; every live task it owns, background tasks included, and
 * every conversation those tasks own are marked, and its queued inputs are withdrawn. `tasks`: mark these and the work
 * they own. `submissions`: withdraw exactly these queued inputs. `spareBackground`: the traversal from `tasks` stops at
 * a background task that the intent does not name, as `Conversation.abort()` does (Esc spares Team Workers).
 */
export type StopIntent = { id: string; conversations?: string[]; tasks?: string[]; submissions?: string[]; spareBackground?: boolean };

/** What became of one stop after settlement. `settled`: every task reached is terminal; it lists their outcomes. */
export type StopOutcome =
	| { status: "settled"; tasks: Record<string, string> }
	| { status: "failed"; tasks: Record<string, string>; error: string };

/** The work a mark reached: conversations fenced, tasks marked, and queued inputs returned. */
export type Marked = { conversations: Set<string>; tasks: Set<string>; submissions: ControlSubmission[]; spareBackground?: boolean };

/**
 * Marks the work without starting the scheduler. In pi-durable 1.4.0, abortTask commits before it joins a live
 * invocation. Enqueue every abort, then verify their marks on the same commit line. Cancel only the join waiters.
 * Safe before resume(); settlement is separate.
 */
/**
 * What a returned input reports: the owner's text, or a Team input's origin without its text, and its image count. The
 * composer restores text into the owner's draft, and a Team input is not the owner's to send. Pi returns no images, so
 * the count tells the owner to attach them again.
 */
export function returnedInput(item: { mode: string; content?: unknown; entry?: unknown } | undefined): Pick<ControlSubmission, "text" | "origin" | "images"> {
	if (!item || item.mode === "write") return {};
	const text = contentText(item.content as never);
	const origin = queueOrigin(item.entry as never, text);
	const images = countImages(item.content as never);
	return { ...(origin ? { origin } : text ? { text } : {}), ...(images ? { images } : {}) };
}

export async function markStops(harness: Harness, intents: readonly StopIntent[], context: Context): Promise<Marked> {
	const conversations = new Set(intents.flatMap((intent) => intent.conversations ?? []));
	const explicit = new Set(intents.flatMap((intent) => intent.tasks ?? []));
	const withdraw = new Set(intents.flatMap((intent) => intent.submissions ?? []));
	const spareBackground = intents.length > 0 && intents.every((intent) => intent.spareBackground);
	const inspection = await harness.inspect(context);
	const live = inspection.tasks.map((task) => task.record).filter((record) => record.state.status !== "terminal");
	// Conversations owned by a task: subagents and Workers end with the work that owns them.
	const owned = new Map<string, string[]>();
	if (conversations.size > 0 || explicit.size > 0) {
		const ids = new Set(live.map((record) => String(record.conversationId)));
		const records = await harness.commit(
			(tx) => Promise.all([...ids].map((id) => tx.conversation(Number(id) as ConversationId))),
			context,
		);
		for (const record of records) {
			const owner = record?.owner?.taskId;
			if (record && owner !== undefined) owned.set(String(owner), [...(owned.get(String(owner)) ?? []), String(record.id)]);
		}
	}
	const tasks = new Set<string>();
	for (let grew = true; grew; ) {
		grew = false;
		for (const record of live) {
			const id = String(record.id);
			if (tasks.has(id) || (spareBackground && record.background && !explicit.has(id))) continue;
			const reached =
				explicit.has(id) ||
				conversations.has(String(record.conversationId)) ||
				(record.owner !== undefined && tasks.has(String(record.owner)));
			if (!reached) continue;
			tasks.add(id);
			for (const conversation of owned.get(id) ?? []) conversations.add(conversation);
			grew = true;
		}
	}
	const joins = withCancel(context);
	const requests = [...tasks].map((id) => harness.abortTask(Number(id) as TaskId, joins.context));
	// Attach rejection handlers immediately; a failed commit must not become an unhandled rejection.
	const completed = Promise.allSettled(requests);
	try {
		await harness.commit(async (tx) => {
			for (const id of tasks) {
				const task = await tx.task(Number(id) as TaskId);
				if (!task || (task.state.status !== "terminal" && !task.abortRequested)) {
					throw new Error(`Stop mark missing for task ${id}`);
				}
			}
		}, context);
	} finally {
		joins.cancel();
		await completed;
	}
	const submissions: ControlSubmission[] = [];
	const queued = inspection.submissions.filter((s) => s.status === "queued" && (conversations.has(String(s.conversationId)) || withdraw.has(String(s.id))));
	const inboxes = new Map<string, Awaited<ReturnType<typeof inboxOf>>>();
	for (const submission of queued) {
		const conversation = String(submission.conversationId);
		if (!inboxes.has(conversation)) inboxes.set(conversation, await inboxOf(harness, conversation, context));
		const item = inboxes.get(conversation)?.items.find((candidate) => candidate.id === submission.id);
		const result = await harness.abortSubmission(submission.id as SubmissionId, context, submission.conversationId);
		if (result !== "aborted" || submission.type !== "input") continue;
		submissions.push({ submission: String(submission.id), deliverAs: item?.mode === "steer" ? "steer" : "followUp", state: "returned", at: Date.now(), ...returnedInput(item) });
	}
	return { conversations, tasks, submissions, ...(spareBackground ? { spareBackground } : {}) };
}

function inboxOf(harness: Harness, conversation: string, context: Context) {
	return harness.snapshot(InboxDoc, Number(conversation) as ConversationId, context);
}

/**
 * Settles marked work. Starts the scheduler (`waitForTask`, `Conversation.abort`), so it runs only after every stored
 * intent of the store is marked. Fenced conversations are aborted across background boundaries, so background
 * subagents end too.
 */
export async function settleStops(harness: Harness, marked: Marked, context: Context): Promise<StopOutcome> {
	const outcomes: Record<string, string> = {};
	const errors: string[] = [];
	await Promise.all([
		...[...marked.conversations].map(async (id) => {
			try {
				const conversation = await harness.conversation(Number(id) as ConversationId, context);
				await conversation?.abort(context, marked.spareBackground ? undefined : { background: true });
			} catch (error) {
				errors.push(`conversation ${id}: ${(error as Error).message}`);
			}
		}),
		...[...marked.tasks].map(async (id) => {
			try {
				outcomes[id] = (await harness.waitForTask(Number(id) as TaskId, context)).state.outcome.status;
			} catch (error) {
				outcomes[id] = "unknown";
				errors.push(`task ${id}: ${(error as Error).message}`);
			}
		}),
	]);
	return errors.length ? { status: "failed", tasks: outcomes, error: errors.join("; ") } : { status: "settled", tasks: outcomes };
}
