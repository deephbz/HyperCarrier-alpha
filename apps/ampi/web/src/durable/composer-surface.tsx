// The durable thread's composer slots (shell-slots.ts ComposerSurface): local view commands, the queue with Team inputs
// and queued edits, Stop's returned text, the archived read-only state, the model picker, and the simulator banner.

import { composing } from "../composer-keys.ts";
import { useEffect, useRef, useState } from "react";
import type { EditQueuedResult, PiQueuedItem, QueueOrigin, ThreadSummary } from "../../../src/shared/protocol.ts";
import { teamBadge } from "../../../src/shared/team-origin.ts";
import { hub, useHosts } from "../client.ts";
import { hostErrorMessage, sendOutcome } from "../composer-outcomes.ts";
import type { Outcome } from "../composer-drafts.ts";
import { openAccounts } from "../components/Accounts.tsx";
import { ModelHudCard } from "../components/ModelHudCard.tsx";
import { hostLabelFor } from "../components/host-label.ts";
import { newId } from "../ids.ts";
import { modelLabel } from "../model-label.ts";
import { useModels } from "../models.ts";
import type { ComposerApi, ComposerPlace, ComposerSurface, LocalCommand, ModelControlProps, QueueOutcome, QueueProps } from "../shell-slots.ts";
import { closedState, go, tokens } from "../util.ts";
import { durableHint } from "./drafts.ts";

// biome-ignore lint: live and inbox docs are loosely typed JSON
type Any = any;

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** A durable Stop puts a returned message into this composer's draft. */
const OUTCOMES: Record<string, QueueOutcome> = {
	returned: { badge: "not sent", tone: "attn", note: "returned to the composer", recover: "Put this text into the composer. Stop may already have put it there, so check the composer before you send." },
};

/** Why a returned Team input stays unsent: Stop settles its delivery unanswered, and durable-team does not resend it. */
const TEAM_NOT_SENT = "not sent · durable-team does not resend it";
/**
 * What the owner can do about a returned Team input. A Task stays assigned and readable, and a lead revision gives it
 * a new version, which durable-team delivers again. An Alert is delivered once per Alert ID.
 */
function teamNotSent(origin: QueueOrigin): string {
	if (origin.delivery === "task" && origin.taskId) return `not sent · the Worker can still read Task ${origin.taskId}; the lead may resend it`;
	if (origin.delivery === "alert") return `${TEAM_NOT_SENT}; ask the lead to resend`;
	return TEAM_NOT_SENT;
}

/** Local durable view actions. The host owns built-ins, templates, and skills. */
function localCommands({ host, threadId, view, summary }: ComposerPlace, api: ComposerApi): LocalCommand[] {
	const openPanel = (name: string) => api.openPanel?.(name);
	return [
		{
			name: "fork",
			help: "Fork a new thread from the latest message",
			run: async () => {
				const last = view.entries.at(-1);
				if (!last) throw new Error("Nothing to fork yet");
				const { threadId: forked } = await hub.request(host, "thread.fork", { threadId, entryId: last.id });
				go(host, forked);
			},
		},
		{
			name: "new",
			args: "[prompt]",
			help: "Start a new thread in this directory with this model",
			run: async (arg) => {
				const agent = view.agent as Any;
				const ref: string | undefined = agent?.model ?? summary?.model;
				const slash = ref?.indexOf("/") ?? -1;
				const { threadId: created } = await hub.request(host, "thread.create", {
					cwd: agent?.cwd ?? summary?.cwd,
					...(ref && slash > 0 ? { model: { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) } } : {}),
					requestId: newId(),
					...(arg.trim() ? { prompt: arg.trim() } : {}),
				});
				go(host, created);
			},
		},
		{
			name: "rename",
			args: "<title>",
			help: "Rename this thread",
			run: async (arg) => {
				if (!arg.trim()) throw new Error("Give a title");
				await hub.request(host, "thread.rename", { threadId, title: arg.trim() });
			},
		},
		{ name: "changes", help: "Show the files this thread changed", run: () => openPanel("changes") },
		{ name: "team", help: "Show the Team and its Task graph", run: () => openPanel("team") },
		{
			name: "context",
			help: "Show context use",
			run: () => {
				api.say(summary?.contextTokens ? `Context: ${tokens(summary.contextTokens)} of a ${tokens(summary.workingBudget ?? summary.contextWindow)} working budget (window ${tokens(summary.contextWindow)})` : "No model response yet");
			},
		},
	];
}

/** A legacy closed thread stays readable as archived; its last reason remains visible as history. */
export function ClosedFeedback({ summary }: { summary: ThreadSummary }) {
	const last = closedState(summary)?.replace(/\.$/, "");
	return <div className="quiet-scroll composer-feedback" data-scrollbar="none" role="status">{last ? `Archived. Last state: ${last}. Unarchive to continue.` : "Archived. Unarchive to continue."}</div>;
}

/**
 * A queued message the owner edits in place: its thread and ID, mode, the text it showed when editing began, and the
 * new text. `editId` names the last save attempt and stays while its text does, so a retry is the same edit.
 */
type QueuedEdit = { threadId: string; id: string; mode: string; expected: string; text: string; editId?: string; sentText?: string; saving?: boolean };

const queueText = (item: Any): string =>
	typeof item.content === "string" ? item.content : Array.isArray(item.content) ? item.content.map((p: Any) => (p.type === "text" ? p.text : "[image]")).join(" ") : item.entry?.data?.title ?? item.entry?.kind ?? "…";

/** The durable queue: Team inputs read-only, owner messages editable in place while queued, and × on every item. */
function DurableQueue({ host, threadId, view, items, api }: QueueProps) {
	const { hosts } = useHosts();
	const hostLabel = hostLabelFor(host, hosts);
	const [openEdit, setEditing] = useState<QueuedEdit>();
	// One editor, on its own thread only. While it saves, the other Edit buttons wait; Esc closes it and frees them.
	const editing = openEdit?.threadId === threadId ? openEdit : undefined;
	const editingRef = useRef(openEdit);
	editingRef.current = openEdit;
	const editLocked = Boolean(editing?.saving);
	// The thread this queue shows; none after unmount, so a late answer knows nobody sees its status line.
	const threadRef = useRef<string | undefined>(threadId);
	threadRef.current = threadId;
	useEffect(() => {
		threadRef.current = threadId;
		setEditing(undefined);
		return () => { threadRef.current = undefined; };
	}, [threadId]);
	const viewRef = useRef(view);
	viewRef.current = view;
	// The edited item stays on screen when the run takes it mid-edit; saving then answers `taken`, and no text is lost.
	const queue: Any[] = editing && !items.some((item) => String(item.id) === editing.id) ? [...items, { id: editing.id, mode: editing.mode, content: editing.expected, state: "queued" }] : items;
	const withdraw = (item: PiQueuedItem) => void hub.request(host, "thread.withdraw", { threadId, submissionId: String(item.id) }).catch((e) => api.fail(e));
	/**
	 * Saves a queued edit as one replace on the node (`thread.editQueued`). Nothing is resent by itself, and typed text
	 * is never dropped: every answer except `edited` puts the edited text at the end of the draft of the edit's own
	 * thread. One exception keeps the text in place: a refusal while the owner still sees the open editor keeps it there.
	 * An unknown outcome asks again under the same `editId` as a retry; the node answers by its record or by the
	 * submission's placed entry. Only the queue item's own ID proves a landed edit here: a transcript entry with the
	 * same text proves nothing. A result changes only its own editor: Esc during a save, or another editor, stays.
	 */
	const saveEdit = async (edit: QueuedEdit) => {
		if (edit.saving) return;
		if (edit.text === edit.expected) return setEditing(undefined);
		if (!edit.text.trim()) return api.fail(new Error("A queued message cannot be empty. Use × to withdraw it."));
		const reused = Boolean(edit.editId && edit.sentText === edit.text);
		const editId = reused ? edit.editId! : newId();
		const saving = { ...edit, editId, sentText: edit.text, saving: true };
		const here = () => threadRef.current === edit.threadId;
		// The owner still sees this edit's editor. editingRef outlives an unmount, so it proves nothing alone.
		const own = () => here() && editingRef.current?.editId === editId;
		const settle = (next: QueuedEdit | undefined) => setEditing((current) => (current?.editId === editId ? next : current));
		// A warning stays with the text in that thread's draft, so it outlives this composer.
		const keep = (outcome?: Outcome) => api.appendDraft(edit.text, outcome);
		setEditing(saving);
		let result: EditQueuedResult | undefined;
		let failure: (Error & { code?: string }) | undefined;
		for (let attempt = 0; attempt < 2 && !result; attempt++) {
			try {
				result = await hub.request(host, "thread.editQueued", { threadId: edit.threadId, submissionId: edit.id, editId, expected: edit.expected, text: edit.text, retry: reused || attempt > 0 });
			} catch (e) {
				failure = e as Error & { code?: string };
				if (!sendOutcome(failure, hostLabel).uncertain) break;
			}
		}
		const late = !own();
		const refused = !result && failure !== undefined && !sendOutcome(failure, hostLabel).uncertain;
		// The queue item's own ID is identity evidence; its text then shows whether the edit landed.
		const queued = here() ? (((viewRef.current.inbox as Any)?.items ?? []) as Any[]).find((item) => String(item.id) === edit.id) : undefined;
		if (!result && !refused && typeof queued?.content === "string" && queued.content === edit.text) result = { edited: true };
		if (result?.edited) {
			settle(undefined);
			if (here()) api.say("Queued message edited");
		} else if (result && result.reason !== "unknown") {
			settle(undefined);
			const reason = result.reason === "taken" ? "The agent already took this message, so your edit was not sent." : "This queued message changed elsewhere, so your edit was not saved.";
			// Text the owner did not type into this draft always carries its reason; off screen, the draft keeps it.
			if (!here()) keep({ uncertain: false, text: `${reason} Your edited text is at the end of the composer.` });
			else {
				keep();
				api.say(`${reason} ${late ? "Your edited text was added to the end of the composer." : "Your edited text is in the composer."}`);
			}
		} else if (refused && !late) {
			settle({ ...saving, saving: false });
			if (here()) api.fail(failure!);
		} else if (refused) {
			keep({ uncertain: false, text: `Not saved: ${hostErrorMessage(failure!, hostLabel).trimEnd().replace(/\.+$/, "")}. Your edited text is at the end of the composer; check the queue before you send.` });
		} else {
			settle(undefined);
			keep({ uncertain: true, text: "Edit outcome unknown: your edited text is at the end of the composer; it may already have been sent. Check the queue before you send." });
		}
	};
	if (!queue.length) return null;
	return (
		<div className="queue quiet-scroll" data-scrollbar="none">
			{queue.map((item) => {
				const origin = item.origin as QueueOrigin | undefined;
				if (origin) {
					// A Team input is read-only (one-gui-views.md, Queue): durable-team owns its delivery. Once returned, × dismisses only its record.
					const returned = item.state === "returned";
					return (
						<div className={`queue-item team ${returned ? "settled" : ""}`} key={item.id} data-origin={origin.delivery} title={returned ? `${teamNotSent(origin)}: ${origin.summary}` : origin.summary}>
							<span className={`badge ${origin.delivery === "alert" ? "attn" : ""}`}>{teamBadge(origin)}</span>
							{origin.sender && <span className="notice-sender">{origin.sender}</span>}
							<span className="notice-first text">{origin.summary}</span>
							{returned && <span className="outcome">{teamNotSent(origin)}</span>}
							{returned && (
								<button className="btn ghost small" title="Dismiss" onClick={() => withdraw(item)}>
									×
								</button>
							)}
						</div>
					);
				}
				const content = queueText(item);
				const outcome = OUTCOMES[item.state as string];
				const open = editing?.id === String(item.id);
				return (
					<div className={`queue-item ${outcome ? "settled" : ""}`} key={item.id} title={outcome ? `${outcome.note}: ${content}` : content}>
						<span className={`badge ${outcome?.tone ?? ""}`}>{outcome ? outcome.badge : item.mode === "steer" ? "steer" : item.mode === "write" ? "note" : "queued"}</span>
						{open ? (
							<textarea
								className="queue-edit quiet-scroll"
								data-scrollbar="none"
								aria-label="Edit queued message"
								rows={Math.min(4, editing.text.split("\n").length)}
								value={editing.text}
								readOnly={editing.saving}
								autoFocus
								onChange={(e) => setEditing({ ...editing, text: e.target.value })}
								onKeyDown={(e) => {
									// Enter saves and Esc cancels here; neither reaches the composer, so Esc never stops the run.
									// Esc during a save closes the editor; the save goes on, and its answer arrives as a note.
									if (e.key === "Enter" && !e.shiftKey && !composing(e.nativeEvent)) {
										e.preventDefault();
										void saveEdit(editing);
									} else if (e.key === "Escape") {
										e.preventDefault();
										e.stopPropagation();
										setEditing(undefined);
										api.focus();
									}
								}}
							/>
						) : (
							<span className="text">{content}</span>
						)}
						{open && <span className="outcome">{editing.saving ? "Saving…" : "Enter saves · Esc cancels"}</span>}
						{outcome && <span className="outcome">{outcome.note}</span>}
						{!outcome && (item.mode === "steer" || item.mode === "followUp") && !open && (
							<button
								className="btn ghost small"
								disabled={editLocked}
								title={editLocked ? "Another queued edit is saving." : "Edit this queued message. Enter saves, Esc cancels."}
								onClick={() => setEditing({ threadId, id: String(item.id), mode: item.mode, expected: typeof item.content === "string" ? item.content : content, text: typeof item.content === "string" ? item.content : content })}
							>
								Edit
							</button>
						)}
						{outcome?.recover && typeof item.content === "string" && (
							<button className="btn ghost small" title={outcome.recover} onClick={() => api.prependDraft(item.content)}>
								Edit here
							</button>
						)}
						<button className="btn ghost small" title={outcome ? "Dismiss" : "Withdraw"} onClick={() => withdraw(item)}>
							×
						</button>
					</div>
				);
			})}
		</div>
	);
}

/** The thread's current model as "provider/id": the view has the latest; the summary has it before the first turn. */
const modelOf = ({ view, summary }: ComposerPlace): string => (view.agent as Any)?.model ?? summary?.model ?? "";

/** One host's models, while its link is up. */
function useHostModels(host: string) {
	const { hosts } = useHosts();
	return useModels(host, hosts.find((h) => h.link === host)?.status === "connected") ?? [];
}

/** A durable thread picks its model and thinking level here, and its HUD trigger sits beside them. */
export function ModelControls(props: ModelControlProps) {
	const { host, threadId, summary, view, closed } = props;
	const models = useHostModels(host);
	const model = modelOf(props);
	const thinkingLevel: string | undefined = (view.agent as Any)?.thinkingLevel;
	return (
		<div className="composer-model-controls">
			<select
				value={model}
				disabled={closed}
				title="Model"
				onChange={(e) => {
					if (e.target.value === "__ampi_accounts__") {
						e.currentTarget.value = model;
						openAccounts(host);
						return;
					}
					const [provider, ...id] = e.target.value.split("/");
					void hub.request(host, "thread.configure", { threadId, model: { provider, modelId: id.join("/") } });
				}}
			>
				{!models.some((m) => `${m.provider}/${m.id}` === model) && model && <option value={model}>{modelLabel(model)}</option>}
				{models.map((m) => (
					<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
						{modelLabel(`${m.provider}/${m.id}`)}
					</option>
				))}
				<option value="__ampi_accounts__">Sign in to more models…</option>
			</select>
			<details className="composer-model-options"><summary aria-label="Model settings">⋯</summary>
			<select
				value={thinkingLevel ?? "medium"}
				disabled={closed}
				title="Thinking level"
				onChange={(e) => void hub.request(host, "thread.configure", { threadId, thinkingLevel: e.target.value })}
			>
				{THINKING.map((level) => (
					<option key={level} value={level}>
						thinking: {level}
					</option>
				))}
			</select>
			{summary && <ModelHudCard summary={{ ...summary, ...(model ? { model } : {}) }} label="HUD" />}
			</details>
		</div>
	);
}

/** Keyed on this thread's model: a thread started before sign-in stays on the simulator until switched. */
function SimulatorBanner(place: ComposerPlace) {
	const { host, threadId } = place;
	const models = useHostModels(host);
	if (!modelOf(place).startsWith("ampi-sim/") || !models.length) return null;
	const realDefault = models.find((m) => m.default && m.provider !== "ampi-sim") ?? models.find((m) => m.provider !== "ampi-sim");
	return (
		<div className="model-banner attn-box" data-no-model>
			{realDefault ? (
				<>
					<span style={{ flex: 1 }}>This thread runs on the offline simulator, which only demonstrates the interface.</span>
					<button className="btn small primary" onClick={() => void hub.request(host, "thread.configure", { threadId, model: { provider: realDefault.provider, modelId: realDefault.id } })}>
						Switch to {realDefault.name}
					</button>
				</>
			) : (
				<>
					<span style={{ flex: 1 }}>No model is signed in on this host. Replies come from the offline simulator, which only demonstrates the interface.</span>
					<button className="btn small primary" onClick={() => openAccounts(host)}>
						Set up models
					</button>
				</>
			)}
		</div>
	);
}

/** Each returned owner submission goes back into the draft once, also across Stops and composer remounts. */
const restored = new Set<string>();

export const DURABLE_COMPOSER: ComposerSurface = {
	localCommands,
	texts: {
		source: "this thread",
		unsupported: "Unavailable on this thread",
		refuseUnsupported: (name) => `/${name} is unavailable on this thread.`,
		noImages: "this AmPi node is too old to take images; restart it",
	},
	deduplicates: true,
	hostDecidesSlash: true,
	literalText: true,
	outcomes: OUTCOMES,
	queue: DurableQueue,
	// A closed durable thread is read-only: the composer keeps the draft and sends nothing.
	readOnly: (summary) => (summary?.closed ? <ClosedFeedback summary={summary} /> : undefined),
	onAbort: (ack, api) => {
		// A Team input is not the owner's message: it never enters the draft and has its own note.
		const team = ack?.submissions?.filter((s) => s.origin && s.state === "returned").length ?? 0;
		const returned = (ack?.submissions?.filter((s) => s.state === "returned").length ?? 0) - team;
		const lost = (ack?.submissions?.length ?? 0) - returned - team;
		const plural = (n: number) => (n === 1 ? "1 queued message" : `${n} queued messages`);
		const teamNote = team ? `${team === 1 ? "1 Team input" : `${team} Team inputs`} ${TEAM_NOT_SENT}` : "";
		// Each compaction is named by its stored outcome: one can finish between Stop's read and its mark.
		const compactions = ack?.compactions?.length ?? 0;
		const stopping = ack?.evidence === "stopping";
		const outcomes = new Map<string, number>();
		for (const c of ack?.compactions ?? []) {
			const clause = c.outcome === "aborted" ? "cancelled, no summary written"
				: c.outcome === "completed" && (c.summary === "placed" || c.summary === "pending") ? "had finished; its summary stands"
				: c.outcome === "unknown" && stopping ? ""
				: `ended: ${c.outcome === "completed" ? `completed, ${c.summary === "stale" ? "summary outdated" : "nothing to summarize"}` : c.outcome}`;
			if (clause) outcomes.set(clause, (outcomes.get(clause) ?? 0) + 1);
		}
		const compactNote = [...outcomes].map(([clause, n]) => (n === 1 ? `compaction ${clause}` : `${n} compactions ${clause.replace("its summary stands", "their summaries stand")}`)).join("; ");
		const lead = stopping ? "Stop requested; still stopping" : "Stopped";
		// Durable has no TUI editor. Restore each returned owner submission once, before the unsent draft.
		const texts = (ack?.submissions ?? []).flatMap((submission) => {
			const key = `${api.draftKey}/${submission.submission}`;
			if (submission.state !== "returned" || submission.origin || !submission.text || restored.has(key)) return [];
			restored.add(key);
			return [submission.text];
		});
		// Stop proves none was sent, so the texts carry no retry identity and rekey the draft.
		if (texts.length) api.prependDraft(texts.join("\n\n"));
		if (returned || lost || team || compactions || stopping) api.say([lead, compactNote, returned ? `${plural(returned)} ${OUTCOMES.returned!.note}, not sent` : "", teamNote, lost ? `${plural(lost)} not returned; check the transcript` : ""].filter(Boolean).join("; "));
		return true;
	},
	onSubmitted: (_ack, before, api) => {
		if (before?.archived) api.say("Unarchived");
		return true;
	},
	onCommand: (ack, api) => {
		if ((ack.panel === "team" || ack.panel === "rarebit") && api.panel !== ack.panel) api.openPanel?.(ack.panel);
	},
	modelControl: ModelControls,
	banner: SimulatorBanner,
	hint: durableHint,
};
