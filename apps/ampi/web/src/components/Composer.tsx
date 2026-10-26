import { useEffect, useImperativeHandle, useLayoutEffect, type Ref, useRef, useState, useSyncExternalStore } from "react";
import type { PiThreadView, SlashCommands, ThreadSummary, EditQueuedResult, QueueOrigin } from "../../../src/shared/protocol.ts";
import { teamBadge } from "../../../src/shared/team-origin.ts";
import { hub, useHosts } from "../client.ts";
import { hostErrorMessage, sendOutcome } from "../composer-outcomes.ts";
import { hostLabelFor } from "./host-label.ts";
import { COMPOSER_BUSY_HINT, composerSubmission } from "../composer-keys.ts";
import { EMPTY_DRAFT, appendDraftQuote, draftParts, editDraftImages, editDraftText, prependDraftText, refuseIntent, restoreIntents, type ComposerDraft, type SendIntent, appendDraftText, dismissNotice, carriedDraft } from "../composer-drafts.ts";
import { openAccounts } from "./Accounts.tsx";
import { ModelHudCard } from "./ModelHudCard.tsx";
import { MOD, closedState, go, tokens } from "../util.ts";
import { toCss } from "../display.ts";
import type { ModelChoice } from "./ThreadView.tsx";

// biome-ignore lint: live and inbox docs are loosely typed JSON
type Any = any;

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

type Image = { data: string; mimeType: string; name: string };
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ComposerActions = { panel?: string; openPanel: (name: string) => void };

/** `disabled`: listed but not runnable from here. Host commands have no `run`; they use typed ops. */
type Command = { name: string; args?: string; help: string; disabled?: boolean; run?: (arg: string) => Promise<void> | void };
/** The host's command list for one thread and control state (`for`). */
type PiCommands = { for: string; state: "loading" } | { for: string; state: "ready"; value: SlashCommands } | { for: string; state: "failed"; code: string; message: string };
/** An inline decision the composer asks for, with the draft kept. */
type Choice = { message: string; actions: { label: string; run: () => unknown }[] };
/**
 * A queued message the owner edits in place: its thread and ID, mode, the text it showed when editing began, and the
 * new text. `editId` names the last save attempt and stays while its text does, so a retry is the same edit.
 */
type QueuedEdit = { threadId: string; id: string; mode: string; expected: string; text: string; editId?: string; sentText?: string; saving?: boolean };
const PI_NO_EDIT = "Pi cannot edit a queued message; Stop returns it to Pi's input box.";
type QueueOutcome = { badge: string; tone: string; note: string; recover?: string };
/**
 * How the composer names a queued message that left the queue without delivery, per backend. A note names the box
 * that holds the text: Pi's Stop puts it into Pi's input box; a durable Stop puts it into this composer's draft.
 */
const OUTCOMES: Record<"pi" | "durable", Record<string, QueueOutcome>> = {
	pi: {
		returned: { badge: "not sent", tone: "attn", note: "returned to Pi's input box", recover: "Put this text into the composer. Pi's input box still holds it, so clear one copy before you send." },
		dropped: { badge: "not sent", tone: "err", note: "dropped by Pi" },
		unknown: { badge: "unknown", tone: "", note: "Pi stopped reporting this message" },
	},
	durable: {
		returned: { badge: "not sent", tone: "attn", note: "returned to the composer", recover: "Put this text into the composer. Stop may already have put it there, so check the composer before you send." },
	},
};

/** A queued Team input's badge, in the transcript notice grammar. */
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
function commands(ctx: {
	host: string;
	threadId: string;
	view: PiThreadView;
	summary?: ThreadSummary;
	actions: ComposerActions;
	say: (text: string) => void;
}): Command[] {
	const { host, threadId } = ctx;
	return [
		{
			name: "fork",
			help: "Fork a new thread from the latest message",
			run: async () => {
				const last = ctx.view.entries.at(-1);
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
				const agent = ctx.view.agent as Any;
				const ref: string | undefined = agent?.model ?? ctx.summary?.model;
				const slash = ref?.indexOf("/") ?? -1;
				const { threadId: created } = await hub.request(host, "thread.create", {
					cwd: agent?.cwd ?? ctx.summary?.cwd,
					...(ref && slash > 0 ? { model: { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) } } : {}),
					requestId: crypto.randomUUID(),
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
		{ name: "changes", help: "Show the files this thread changed", run: () => ctx.actions.openPanel("changes") },
		{ name: "team", help: "Show the Team and its Task graph", run: () => ctx.actions.openPanel("team") },
		{ name: "stop", help: "Interrupt the current run or compaction (Esc)", run: () => hub.request(host, "thread.abort", { threadId }).then(() => {}) },
		{
			name: "context",
			help: "Show context use",
			run: () => {
				const s = ctx.summary;
				ctx.say(s?.contextTokens ? `Context: ${tokens(s.contextTokens)} of a ${tokens(s.workingBudget ?? s.contextWindow)} working budget (window ${tokens(s.contextWindow)})` : "No model response yet");
			},
		},
	];
}

function readImage(file: File): Promise<Image> {
	return new Promise((resolve, reject) => {
		if (!IMAGE_TYPES.includes(file.type)) return reject(new Error(`${file.name || "That file"} is not a PNG, JPEG, GIF, or WebP image`));
		if (file.size > MAX_IMAGE_BYTES) return reject(new Error(`${file.name || "The image"} is larger than 5 MB`));
		const reader = new FileReader();
		reader.onload = () => resolve({ data: String(reader.result).split(",")[1] ?? "", mimeType: file.type, name: file.name || "pasted image" });
		reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
		reader.readAsDataURL(file);
	});
}

export function ContextMeter({ summary, budget }: { summary?: ThreadSummary; budget?: number }) {
	if (!summary?.contextTokens || !summary.contextWindow) return null;
	const limit = budget ?? summary.workingBudget ?? summary.contextWindow;
	const ratio = summary.contextTokens / limit;
	return (
		<span className="meter" title={`${summary.contextTokens} tokens of a ${limit}-token working budget (model window ${summary.contextWindow})`}>
			<span className={`bar ${ratio >= 1 ? "err" : ratio >= 0.85 ? "warn" : ""}`}>
				<div style={{ width: `${Math.min(100, ratio * 100)}%` }} />
			</span>
			{tokens(summary.contextTokens)}/{tokens(limit)}
		</span>
	);
}

const DRAFTS = new Map<string, ComposerDraft>();
const draftListeners = new Set<() => void>();
let sendOrder = 0;
const subscribeDrafts = (listener: () => void) => { draftListeners.add(listener); return () => { draftListeners.delete(listener); }; };
function updateDraft(key: string, change: (draft: ComposerDraft) => ComposerDraft): void {
	const next = change(DRAFTS.get(key) ?? EMPTY_DRAFT);
	if (next.text || next.images.length || next.spans.length || next.commandResult) DRAFTS.set(key, next);
	else DRAFTS.delete(key);
	for (const listener of draftListeners) listener();
}

/** Add a quote through the same per-Session draft store used by the composer. */
export function quoteDraft(host: string, threadId: string, selection: string, note: string): void {
	updateDraft(`${host}/${threadId}`, (draft) => appendDraftQuote(draft, selection, note));
}

/** A fork of a closed thread continues its unsent draft; the source keeps its copy, and a draft in the fork wins. */
export function carryDraft(host: string, from: string, to: string): void {
	const draft = carriedDraft(DRAFTS.get(`${host}/${from}`), DRAFTS.get(`${host}/${to}`));
	if (draft) updateDraft(`${host}/${to}`, () => draft);
}

/** A legacy closed thread stays readable as archived; its last reason remains visible as history. */
export function ClosedFeedback({ summary }: { summary: ThreadSummary }) {
	const last = closedState(summary)?.replace(/\.$/, "");
	return <div className="quiet-scroll composer-feedback" data-scrollbar="none" role="status">{last ? `Archived. Last state: ${last}. Unarchive to continue.` : "Archived. Unarchive to continue."}</div>;
}

/**
 * The composer's model controls. A Pi Session shows its model with the Session HUD on hover; a durable thread picks
 * its model and thinking level here, and its HUD trigger sits beside them, so both show CH% the same way.
 */
export function ModelControls({ host, threadId, summary, models, model, thinkingLevel, closed, pi }: {
	host: string;
	threadId: string;
	summary?: ThreadSummary;
	models: ModelChoice[];
	/** The thread's current model as "provider/id". */
	model: string;
	thinkingLevel?: string;
	closed: boolean;
	pi: boolean;
}) {
	if (pi) return summary?.model ? <ModelHudCard summary={summary} /> : null;
	return (
		<>
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
				{!models.some((m) => `${m.provider}/${m.id}` === model) && model && <option value={model}>{model}</option>}
				{models.map((m) => (
					<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
						{m.provider}/{m.id}
					</option>
				))}
				<option value="__ampi_accounts__">Sign in to more models…</option>
			</select>
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
		</>
	);
}

export type ComposerHandle = { quote: (text: string, note: string) => void };

/** Drafts and uncertain sends survive Session switches in this page. A page reload clears them. */
export function Composer({
	host,
	threadId,
	view,
	summary,
	models,
	actions,
	pi = false,
	composerRef,
}: {
	host: string;
	threadId: string;
	view: PiThreadView;
	summary?: ThreadSummary;
	models: ModelChoice[];
	actions: ComposerActions;
	/** A Pi Session (D15): only messages, steer, queue, and interrupt; no models, images, or node commands. */
	pi?: boolean;
	composerRef?: Ref<ComposerHandle>;
}) {
	const { hosts } = useHosts();
	const hostLabel = hostLabelFor(host, hosts);
	const otherError = (error: Error & { code?: string }) => `${hostErrorMessage(error, hostLabel)} Your draft is kept; correct the issue and try again.`;
	const draftKey = `${host}/${threadId}`;
	const actionsRef = useRef(actions);
	actionsRef.current = actions;
	const draft = useSyncExternalStore(subscribeDrafts, () => DRAFTS.get(draftKey) ?? EMPTY_DRAFT);
	const { text, images, commandResult } = draft;
	const originRef = useRef<{ key: string; active: boolean }>({ key: draftKey, active: true });
	if (originRef.current.key !== draftKey) originRef.current = { key: draftKey, active: true };
	useEffect(() => {
		const origin = originRef.current;
		origin.active = true;
		return () => { origin.active = false; };
	}, [draftKey]);
	const setText = (value: string | ((text: string) => string)) => updateDraft(draftKey, (current) => editDraftText(current, typeof value === "function" ? value(current.text) : value));
	const setImages = (value: Image[] | ((images: Image[]) => Image[])) => updateDraft(draftKey, (current) => editDraftImages(current, typeof value === "function" ? value(current.images) : value));
	const [error, setError] = useState<string>();
	const [note, setNote] = useState<string>();
	const [pick, setPick] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [choice, setChoice] = useState<Choice>();
	const [piCommands, setPiCommands] = useState<PiCommands>();
	const ref = useRef<HTMLTextAreaElement>(null);
	useImperativeHandle(composerRef, () => ({
		quote(text, note) {
			quoteDraft(host, threadId, text, note);
			requestAnimationFrame(() => {
				const input = ref.current;
				input?.focus();
				input?.setSelectionRange(input.value.length, input.value.length);
			});
		},
	}), [host, threadId]);
	const restored = useRef(new Set<string>());
	const busy = Boolean((view.live as Any)?.run);
	// Stop covers every live work kind of the thread: a run, and a compaction that runs without one.
	const stoppable = busy || Boolean((view.live as Any)?.compactions?.length);
	// A closed durable thread is read-only: the composer keeps the draft and sends nothing.
	const closed = !pi && Boolean(summary?.closed);
	const agent = view.agent as Any;
	// The view carries the Session's latest model as "provider/id"; the summary has it before the first turn.
	const model: string = agent?.model ?? summary?.model ?? "";
	const realDefault = models.find((m) => m.default && m.provider !== "ampi-sim") ?? models.find((m) => m.provider !== "ampi-sim");
	const [openEdit, setEditing] = useState<QueuedEdit>();
	// One editor, on its own thread only. While it saves, the other Edit buttons wait; Esc closes it and frees them.
	const editing = openEdit?.threadId === threadId ? openEdit : undefined;
	const editingRef = useRef(openEdit);
	editingRef.current = openEdit;
	const editLocked = Boolean(editing?.saving);
	// The thread this composer shows; none after unmount, so a late answer knows nobody sees its status line.
	const threadRef = useRef<string | undefined>(threadId);
	threadRef.current = threadId;
	useEffect(() => {
		threadRef.current = threadId;
		return () => { threadRef.current = undefined; };
	}, [threadId]);
	const inbox = ((view.inbox as Any)?.items ?? []) as Any[];
	// The edited item stays on screen when the run takes it mid-edit; saving then answers `taken`, and no text is lost.
	const queue = editing && !inbox.some((item) => String(item.id) === editing.id) ? [...inbox, { id: editing.id, mode: editing.mode, content: editing.expected, state: "queued" }] : inbox;
	const viewRef = useRef(view);
	viewRef.current = view;
	// Reload host commands when the thread or its control changes.
	const commandsFor = `${host}|${threadId}|${summary?.control ? "control" : "keys"}`;
	const loaded = piCommands?.for === commandsFor ? piCommands : undefined;
	const loadedRef = useRef(loaded);
	loadedRef.current = loaded;
	const wantsCommands = text.startsWith("/") && !text.startsWith("//");
	const commandsRequest = useRef<{ for: string; promise: Promise<PiCommands> }>(undefined);
	/** The list for this Session: the request in flight, or a new one after a failure. */
	const loadCommands = (): Promise<PiCommands> => {
		const key = commandsFor;
		if (commandsRequest.current?.for === key && loadedRef.current?.state !== "failed") return commandsRequest.current.promise;
		const promise = hub.request(host, "thread.commands", { threadId }).then(
			(value): PiCommands => ({ for: key, state: "ready", value }),
			(e: Error & { code?: string }): PiCommands => ({ for: key, state: "failed", code: e.code ?? "error", message: e.message }),
		);
		commandsRequest.current = { for: key, promise };
		setPiCommands({ for: key, state: "loading" });
		void promise.then((result) => {
			loadedRef.current = result;
			setPiCommands(result);
		});
		return promise;
	};
	useEffect(() => {
		if (wantsCommands && (!loadedRef.current || loadedRef.current.state === "failed")) void loadCommands();
	}, [wantsCommands, commandsFor]);
	// Without a control the draft is typed into the pane, where Pi's TUI runs the command itself.
	const commandSource = pi ? "Pi" : "this thread";
	const commandsHint = !wantsCommands || loaded?.state === "ready" ? undefined
		: !loaded || loaded.state === "loading" ? `Commands unavailable: loading the list from ${commandSource}…`
		: pi && loaded.code === "no_control" ? "No control socket: Enter types the command into the Pi pane, and Pi runs it there"
		: loaded.code === "commands_unsupported" ? loaded.message
		: `Commands unavailable: ${hostErrorMessage(loaded, hostLabel)}`;
	const local = pi ? [] : commands({ host, threadId, view, summary, actions, say: setNote });
	const discovered = loaded?.state === "ready" ? loaded.value.commands : [];
	const list: Command[] = [
		{ name: "stop", help: "Interrupt the current run or compaction (Esc)", run: () => abort() },
		...discovered
			.filter((c) => c.name !== "stop" && (c.supported || !local.some((action) => action.name === c.name)))
			.map((c) => ({ name: c.name, args: c.argsHint, help: c.supported ? (c.description ?? c.source) : pi ? "Only in the Pi pane" : "Unavailable on this thread", disabled: !c.supported })),
		...local.filter((c) => c.name !== "stop" && !discovered.some((remote) => remote.name === c.name && remote.supported)),
	];
	// After `/model `, complete from the models this Pi can use and mark the current one.
	const modelRefs = loaded?.state === "ready" && /^\/model \S*$/.test(text)
		? loaded.value.models.map((m) => ({ name: `model ${m.ref}`, help: m.ref === loaded.value.model ? "current" : (m.name ?? "") }))
		: [];
	const menu: Command[] = [...list, ...modelRefs];
	const slash = /^\/(\S*)$/.exec(text) ?? (modelRefs.length ? /^\/(model \S*)$/.exec(text) : null);
	const matches = slash ? menu.filter((c) => c.name.toLowerCase().startsWith(slash[1]!.toLowerCase())) : [];
	useEffect(() => {
		ref.current?.focus();
		setEditing(undefined);
	}, [threadId]);
	useEffect(() => setPick(0), [slash?.[1]]);
	useEffect(() => {
		if (!note) return;
		const timer = setTimeout(() => setNote(undefined), 4000);
		return () => clearTimeout(timer);
	}, [note]);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		// Measure outside layout. Shrinking the live input first clamps the transcript's scrollTop.
		const measure = el.cloneNode() as HTMLTextAreaElement;
		measure.value = el.value;
		measure.removeAttribute("id");
		measure.setAttribute("aria-hidden", "true");
		measure.tabIndex = -1;
		// The live input's computed width is its own CSS px; its rect width is screen px, which display zoom scales.
		Object.assign(measure.style, { position: "fixed", visibility: "hidden", pointerEvents: "none", top: "0", left: "-10000px", width: getComputedStyle(el).width, height: "0", minHeight: "0", maxHeight: "none" });
		el.parentElement!.append(measure);
		const height = measure.scrollHeight;
		measure.remove();
		el.style.height = `${Math.min(height, toCss(window.innerHeight * 0.4, el))}px`;
	}, [text]);
	const attach = async (files: Iterable<File>) => {
		if (closed) return;
		setError(undefined);
		for (const file of files) {
			try {
				const image = await readImage(file);
				setImages((prev) => (prev.length >= 8 ? prev : [...prev, image]));
			} catch (e) {
				setError(otherError(e as Error));
			}
		}
	};
	const runCommand = async (content: string): Promise<boolean> => {
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content);
		const command = match && list.find((c) => c.name === match[1]!.toLowerCase());
		if (!command?.run) return false;
		await command.run(match![2] ?? "");
		return true;
	};
	const offerText = (message: string, whenBusy: "followUp" | "steer") =>
		setChoice({
			message: `${message}. Nothing was sent.`,
			actions: [
				{ label: "Send as text", run: () => send(whenBusy, undefined, { literal: true }) },
				{ label: "Edit", run: () => ref.current?.focus() },
			],
		});
	/** The send owns its key before discovery or admission can await another reply. */
	const runTyped = async (item: SendIntent, route: Extract<NonNullable<SendIntent["route"]>, { kind: "command" }>): Promise<void> => {
		const { name, args, abort: abortTurn } = route;
		const { text: content, whenBusy } = item;
		item.route = route;
		const origin = originRef.current;
		try {
			const ack = await hub.request(host, "thread.command", { threadId, name, ...(args ? { args } : {}), key: item.id, whenBusy, ...(abortTurn ? { abort: true } : {}) });
			const notice = ack.notice ?? (ack.disposition === "started" ? "Started a turn" : ack.disposition === "queued" ? "Queued" : `Sent /${name} to ${commandSource}`);
			let currentCommand = false;
			updateDraft(draftKey, (current) => {
				if (current.commandResult?.id !== item.id) return current;
				currentCommand = true;
				return { ...current, commandResult: { id: item.id, notice, body: ack.body } };
			});
			if (origin.active && originRef.current === origin) {
				commandsRequest.current = undefined;
				loadedRef.current = undefined;
				setPiCommands(undefined);
				if (currentCommand && (ack.panel === "team" || ack.panel === "rarebit") && actionsRef.current.panel !== ack.panel) actionsRef.current.openPanel(ack.panel);
			}
		} catch (e) {
			const { code, message } = e as Error & { code?: string };
			if (pi && code === "no_control") return deliver(item, content);
			if (code === "busy" && (name === "compact" || (name === "auto-compact" && /^run(?:\s|$)/.test(args))))
				setChoice({
					message: "Compact stops the running turn. Stop and compact?",
					actions: [
						{ label: "Stop and compact", run: () => send(whenBusy, undefined, { abort: true }) },
						{ label: "Cancel", run: () => ref.current?.focus() },
					],
				});
			if (code === "commands_unsupported") offerText(message.replace(/\.$/, ""), whenBusy);
			throw e;
		}
	};
	/** A slash draft: false only for Pi's pane fallback. */
	const hostCommand = async (item: SendIntent, abortTurn = false): Promise<boolean> => {
		const content = item.text.trim(), whenBusy = item.whenBusy;
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content);
		if (!match) return false;
		const name = match[1]!;
		if (name === "stop") { await abort(); return true; }
		const current = loadedRef.current?.state === "ready" ? loadedRef.current : await loadCommands();
		if (pi && current.state === "failed" && current.code === "no_control") return false;
		if (current.state !== "ready") {
			if (current.state === "failed" && current.code === "commands_unsupported") {
				offerText(current.message.replace(/\.$/, ""), whenBusy);
				throw Object.assign(new Error(current.message), { code: "commands_unsupported" });
			}
			throw new Error(`Commands unavailable: ${current.state === "failed" ? current.message : `the list did not load from ${commandSource}`}.`);
		}
		const known = current.value.commands.find((c) => c.name === name);
		if (known?.supported) await runTyped(item, { kind: "command", name, args: match[2]?.trim() ?? "", ...(abortTurn ? { abort: true } : {}) });
		else if (!pi && await runCommand(content)) return true;
		else if (!known) {
			offerText(`${pi ? "Pi" : "This thread"} has no /${name} command`, whenBusy);
			throw Object.assign(new Error("Unknown command"), { code: "command_choice" });
		} else throw Object.assign(new Error(pi ? `/${name} works only in the Pi pane.` : `/${name} is unavailable on this thread.`), { code: "unsupported" });
		return true;
	};
	/** Snapshot all parts before awaiting. A failure stops this batch and restores its unsent parts. */
	const send = async (whenBusy: "followUp" | "steer", replacement?: string, options: { literal?: boolean; abort?: boolean } = {}) => {
		if (closed) return;
		if (replacement !== undefined) setText(replacement);
		const current = DRAFTS.get(draftKey) ?? EMPTY_DRAFT;
		const parts = draftParts(current).filter((part) => part.text.trim() || part.images.length);
		if (!parts.length) return;
		const batch = parts.map((part): SendIntent => part.intent ?? { id: crypto.randomUUID(), order: ++sendOrder, text: part.text, images: part.images, whenBusy });
		const command = batch.findLast((item) => !item.images.length && /^\/(?!\/)/.test(item.text.trim()) && !options.literal);
		updateDraft(draftKey, () => ({ ...EMPTY_DRAFT, commandResult: command ? { id: command.id } : current.commandResult }));
		setNote(undefined);
		setError(undefined);
		setChoice(undefined);
		for (let index = 0; index < batch.length; index++) {
			const item = batch[index]!;
			try {
				if (item.route?.kind === "command") await runTyped(item, item.route);
				else if (item.route?.kind === "message") await deliver(item, item.route.content);
				else if (options.literal) await deliver(item, item.text);
				else if (!item.images.length && item.text.trim().startsWith("//")) await deliver(item, item.text.replace(/^(\s*)\//, "$1"));
				else if (!item.images.length && item.text.trim().startsWith("/") && await hostCommand(item, options.abort)) { /* handled */ }
				else await deliver(item, item.text);
			} catch (e) {
				const failure = e as Error & { code?: string };
				const { code } = failure;
				const outcome = sendOutcome(failure, hostLabel, pi);
				updateDraft(draftKey, (newer) => {
					const restored = restoreIntents(newer, batch.slice(index));
					return outcome.finalRefusal ? refuseIntent(restored, item.id) : restored;
				});
				if (!["command_choice", "commands_unsupported"].includes(code ?? "") && !(code === "busy" && item.route?.kind === "command" && (item.route.name === "compact" || (item.route.name === "auto-compact" && /^run(?:\s|$)/.test(item.route.args))))) setError(outcome.text);
				return;
			}
		}
	};
	/** The editor text and payload stay separate so an escaped slash retries the same request. */
	const deliver = async (item: SendIntent, content: string) => {
		item.route = { kind: "message", content };
		const { images: sent, whenBusy } = item;
		const wasArchived = summary?.archived;
		const ack = await hub.request(host, "thread.submit", {
			threadId, content, whenBusy, requestId: item.id,
			...(sent.length ? { images: sent.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
		});
		if (wasArchived) setNote("Unarchived");
		if (pi && ack?.evidence) setNote(ack.evidence === "sent" ? "Typed into the pane (no admission receipt)" : ack.evidence === "started" ? "Started a turn" : whenBusy === "steer" ? "Steer admitted" : "Queued");
	};
	const abort = async () => {
		try {
			const ack = await hub.request(host, "thread.abort", { threadId });
			// Pi's abort puts queued input back into its editor draft and never sends it (O3).
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
			if (!pi) {
				// Durable has no TUI editor. Restore each returned owner submission once, before the unsent draft.
				const texts = (ack?.submissions ?? []).flatMap((submission) => {
					const key = `${draftKey}/${submission.submission}`;
					if (submission.state !== "returned" || submission.origin || !submission.text || restored.current.has(key)) return [];
					restored.current.add(key);
					return [submission.text];
				});
				if (texts.length) updateDraft(draftKey, (current) => prependDraftText(current, texts.join("\n\n")));
				if (returned || lost || team || compactions || stopping) setNote([lead, compactNote, returned ? `${plural(returned)} ${OUTCOMES.durable.returned!.note}, not sent` : "", teamNote, lost ? `${plural(lost)} not returned; check the transcript` : ""].filter(Boolean).join("; "));
				return;
			}
			if (returned || lost) setNote(["Stopped", returned ? `${plural(returned)} ${OUTCOMES.pi.returned!.note}, not sent` : "", lost ? `${plural(lost)} dropped by Pi` : ""].filter(Boolean).join("; "));
		} catch (e) {
			setError(otherError(e as Error));
		}
	};
	// Puts a returned message into this composer; Pi's input box keeps its own copy, so nothing is sent twice by itself.
	const recover = (content: string) => {
		updateDraft(draftKey, (current) => prependDraftText(current, content));
		ref.current?.focus();
	};
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
		if (!edit.text.trim()) return setError("A queued message cannot be empty. Use × to withdraw it.");
		const reused = Boolean(edit.editId && edit.sentText === edit.text);
		const editId = reused ? edit.editId! : crypto.randomUUID();
		const saving = { ...edit, editId, sentText: edit.text, saving: true };
		const editDraftKey = draftKey;
		const here = () => threadRef.current === edit.threadId;
		// The owner still sees this edit's editor. editingRef outlives an unmount, so it proves nothing alone.
		const own = () => here() && editingRef.current?.editId === editId;
		const settle = (next: QueuedEdit | undefined) => setEditing((current) => (current?.editId === editId ? next : current));
		// A warning stays with the text in that thread's draft, so it outlives this composer.
		const keep = (warning?: string) => updateDraft(editDraftKey, (current) => appendDraftText(current, edit.text, warning));
		setEditing(saving);
		setError(undefined);
		let result: EditQueuedResult | undefined;
		let failure: (Error & { code?: string }) | undefined;
		for (let attempt = 0; attempt < 2 && !result; attempt++) {
			try {
				result = await hub.request(host, "thread.editQueued", { threadId: edit.threadId, submissionId: edit.id, editId, expected: edit.expected, text: edit.text, retry: reused || attempt > 0 });
			} catch (e) {
				failure = e as Error & { code?: string };
				if (sendOutcome(failure, hostLabel).finalRefusal) break;
			}
		}
		const late = !own();
		const refused = !result && failure !== undefined && sendOutcome(failure, hostLabel).finalRefusal;
		// The queue item's own ID is identity evidence; its text then shows whether the edit landed.
		const queued = here() ? (((viewRef.current.inbox as Any)?.items ?? []) as Any[]).find((item) => String(item.id) === edit.id) : undefined;
		if (!result && !refused && typeof queued?.content === "string" && queued.content === edit.text) result = { edited: true };
		if (result?.edited) {
			settle(undefined);
			if (here()) setNote("Queued message edited");
		} else if (result && result.reason !== "unknown") {
			settle(undefined);
			const reason = result.reason === "taken" ? "The agent already took this message, so your edit was not sent." : "This queued message changed elsewhere, so your edit was not saved.";
			// Text the owner did not type into this draft always carries its reason; off screen, the draft keeps it.
			if (!here()) keep(`${reason} Your edited text is at the end of the composer.`);
			else {
				keep();
				setNote(`${reason} ${late ? "Your edited text was added to the end of the composer." : "Your edited text is in the composer."}`);
			}
		} else if (refused && !late) {
			settle({ ...saving, saving: false });
			if (here()) setError(otherError(failure!));
		} else if (refused) {
			keep(`Not saved: ${hostErrorMessage(failure!, hostLabel).trimEnd().replace(/\.+$/, "")}. Your edited text is at the end of the composer; check the queue before you send.`);
		} else {
			settle(undefined);
			keep("Edit outcome unknown: your edited text is at the end of the composer; it may already have been sent. Check the queue before you send.");
		}
	};
	return (
		<div
			className={`composer-wrap ${dragging ? "dragging" : ""}`}
			onDragOver={(e) => {
				if (![...e.dataTransfer.items].some((i) => i.kind === "file")) return;
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={(e) => {
				if (!e.dataTransfer.files.length) return;
				e.preventDefault();
				setDragging(false);
				void attach(e.dataTransfer.files);
			}}
		>
			{queue.length > 0 && (
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
										<button className="btn ghost small" title="Dismiss" onClick={() => void hub.request(host, "thread.withdraw", { threadId, submissionId: String(item.id) }).catch((e) => setError(otherError(e)))}>
											×
										</button>
									)}
								</div>
							);
						}
						const content = typeof item.content === "string" ? item.content : Array.isArray(item.content) ? item.content.map((p: Any) => (p.type === "text" ? p.text : "[image]")).join(" ") : item.entry?.data?.title ?? item.entry?.kind ?? "…";
						// A Pi item names its outcome (P7): queued in Pi, or never sent and why.
						const outcome = OUTCOMES[pi ? "pi" : "durable"][item.state as string];
						return (
							<div className={`queue-item ${outcome ? "settled" : ""}`} key={item.id} title={outcome ? `${outcome.note}: ${content}` : content}>
								<span className={`badge ${outcome?.tone ?? ""}`}>{outcome ? outcome.badge : item.mode === "steer" ? "steer" : item.mode === "write" ? "note" : "queued"}</span>
								{editing?.id === String(item.id) ? (
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
											if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
												e.preventDefault();
												void saveEdit(editing);
											} else if (e.key === "Escape") {
												e.preventDefault();
												e.stopPropagation();
												setEditing(undefined);
												ref.current?.focus();
											}
										}}
									/>
								) : (
									<span className="text">{content}</span>
								)}
								{editing?.id === String(item.id) && <span className="outcome">{editing.saving ? "Saving…" : "Enter saves · Esc cancels"}</span>}
								{outcome && <span className="outcome">{outcome.note}</span>}
								{!pi && !outcome && (item.mode === "steer" || item.mode === "followUp") && editing?.id !== String(item.id) && (
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
									<button className="btn ghost small" title={outcome.recover} onClick={() => recover(item.content)}>
										Edit here
									</button>
								)}
								{!(pi && item.state === "queued") && (
									<button className="btn ghost small" title={outcome ? "Dismiss" : "Withdraw"} onClick={() => void hub.request(host, "thread.withdraw", { threadId, submissionId: String(item.id) }).catch((e) => setError(otherError(e)))}>
										×
									</button>
								)}
							</div>
						);
					})}
					{pi && queue.some((item) => item.state === "queued" && (item.mode === "steer" || item.mode === "followUp")) && <div className="hint queue-hint">{PI_NO_EDIT}</div>}
				</div>
			)}
			{(matches.length > 0 || commandsHint) && (
				<div className="slash-menu quiet-scroll" role="listbox" data-slash-menu>
					{matches.map((c, i) => (
						<div
							key={c.name}
							role="option"
							aria-selected={i === pick}
							className={`slash-item ${i === pick ? "on" : ""}`}
							aria-disabled={c.disabled || undefined}
							style={c.disabled ? { opacity: 0.55 } : undefined}
							onMouseEnter={() => setPick(i)}
							onMouseDown={(e) => {
								e.preventDefault();
								setText(`/${c.name}${c.args ? " " : ""}`);
								ref.current?.focus();
							}}
						>
							<code>/{c.name}</code>
							{c.args && <span className="hint"> {c.args}</span>}
							<span className="grow" />
							<span className="hint">{c.help}</span>
						</div>
					))}
					<div className="hint slash-foot" data-commands-hint={commandsHint ? "" : undefined}>
						{commandsHint ?? "Tab completes · //text sends /text as a message"}
					</div>
				</div>
			)}
			{/* Keyed on this thread's model: a thread started before sign-in stays on the simulator until switched. */}
			{!pi && model.startsWith("ampi-sim/") && models.length > 0 && (
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
			)}
			<div className="composer" data-region="composer" tabIndex={-1}>
				{images.length > 0 && (
					<div className="attachments">
						{images.map((image, i) => (
							<div className="attachment" key={i} title={image.name}>
								<img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
								<button className="btn ghost small" title="Remove" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
									×
								</button>
							</div>
						))}
					</div>
				)}
				<textarea
					ref={ref}
					className="quiet-scroll"
					data-scrollbar="none"
					value={text}
					rows={1}
					disabled={closed}
					aria-label="Message the agent"
					placeholder={
						busy
							? COMPOSER_BUSY_HINT
							: pi
								? summary?.control
									? "Message the agent… (Enter starts a turn, Shift+Enter adds a line, / for commands)"
									: "Message the agent… (Enter types it into the Herdr pane, Shift+Enter adds a line)"
								: "Message the agent… (Enter sends, Shift+Enter adds a line, / for commands, paste or drop images)"
					}
					onChange={(e) => {
						setText(e.target.value);
						setChoice(undefined);
					}}
					onPaste={(e) => {
						const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
						if (files.length) {
							e.preventDefault();
							void attach(files);
						}
					}}
					onKeyDown={(e) => {
						const whenBusy = composerSubmission({ key: e.key, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing });
						if (matches.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
							e.preventDefault();
							setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
						} else if (matches.length > 0 && e.key === "Tab") {
							e.preventDefault();
							const c = matches[pick]!;
							setText(`/${c.name}${c.args ? " " : ""}`);
						} else if (whenBusy) {
							e.preventDefault();
							// Enter on a partly typed command picks the highlighted one.
							if (matches.length > 0 && !menu.some((c) => `/${c.name}` === text.trim())) {
								const c = matches[pick]!;
								if (c.args) return setText(`/${c.name} `);
								void send(whenBusy, `/${c.name}`);
								return;
							}
							void send(whenBusy);
						} else if (e.key === "Escape" && matches.length > 0) {
							e.preventDefault();
							setText("");
						} else if (e.key === "Escape" && stoppable) {
							e.preventDefault();
							abort();
						}
					}}
				/>
				{closed && <ClosedFeedback summary={summary!} />}
				{draft.notices?.map((notice) => (
					<div key={notice.id} className="quiet-scroll composer-feedback error" data-scrollbar="none" role="alert">
						{notice.message}{" "}
						<button className="btn ghost small" onClick={() => updateDraft(draftKey, (current) => dismissNotice(current, notice.id))}>
							Dismiss
						</button>
					</div>
				))}
				{error && <div className="quiet-scroll composer-feedback error" data-scrollbar="none" role="alert">{error}</div>}
				{commandResult?.notice && <div className="quiet-scroll composer-feedback" data-scrollbar="none" role="status" data-command-result>
					{commandResult.body ? <details key={commandResult.id}>
						<summary>{commandResult.body.split("\n")[0] || commandResult.notice}</summary>
						<div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{commandResult.body.split("\n").slice(1).join("\n")}</div>
					</details> : commandResult.notice}
					<button className="btn ghost small" onClick={() => updateDraft(draftKey, (current) => ({ ...current, commandResult: undefined }))}>Dismiss</button>
				</div>}
				{note && !error && <div className="quiet-scroll composer-feedback" data-scrollbar="none" role="status">{note}</div>}
				{choice && (
					<div className="quiet-scroll composer-feedback" data-scrollbar="none" role="alert" data-command-choice>
						{choice.message}{" "}
						{choice.actions.map((a) => (
							<button key={a.label} className="btn small" onClick={() => (setChoice(undefined), void a.run())}>
								{a.label}
							</button>
						))}
					</div>
				)}
				<div className="composer-bar">
					<ModelControls host={host} threadId={threadId} summary={summary} models={models} model={model} thinkingLevel={agent?.thinkingLevel} closed={closed} pi={pi} />
					<span className="grow" />
					{summary && <ContextMeter summary={summary} />}
					<div className="composer-actions">
					{busy ? (
						<>
							<button className="btn small" onClick={() => void send("followUp")} disabled={!text.trim() && images.length === 0} title="Queue a follow-up for when the agent finishes (Alt+Enter)">
								Queue
							</button>
							<button className="btn small" onClick={() => void send("steer")} disabled={!text.trim() && images.length === 0} title="Steer: deliver after the current tool round (Enter)">
								Steer ↵
							</button>
							<button className="btn small danger" onClick={abort} title="Interrupt (Esc)">
								■ Stop
							</button>
						</>
					) : (
						<>
							<button className="btn primary small" onClick={() => void send("steer")} disabled={closed || (!text.trim() && images.length === 0)}>
								Send ↵
							</button>
							{stoppable && (
								<button className="btn small danger" onClick={abort} title="Cancel the compaction (Esc)">
									■ Stop
								</button>
							)}
						</>
					)}
					</div>
				</div>
			</div>
		</div>
	);
}
