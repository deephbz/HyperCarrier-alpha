import { type ReactNode, type Ref, type SetStateAction, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ImageLimits, PiQueuedItem, PiThreadView, SlashCommands, ThreadSummary } from "../../../src/shared/protocol.ts";
import { admitImages, base64Length, rejectionLine } from "../../../src/shared/image-admission.ts";
import { hub, useHosts } from "../client.ts";
import { composerHint, composerSubmission } from "../composer-keys.ts";
import { type Custody, type Draft, type Outcome, type SendIntent, appendDraftQuote, appendDraftText, dismissNotice, editDraft, giveBack, isEmpty, messageText, noticeKeyed, outcomeText, restoreReturned, takeDraft } from "../composer-drafts.ts";
import { hostErrorMessage, sendOutcome } from "../composer-outcomes.ts";
import { toCss, touchFields } from "../display.ts";
import { useHoverCard } from "./hover-card.tsx";
import { ModelHudCard } from "./ModelHudCard.tsx";
import { Popover, hoverIntent } from "./Popover.tsx";
import { tokens } from "../util.ts";
import { hostLabelFor } from "./host-label.ts";
import { newId } from "../ids.ts";
import { type ComposerApi, type ComposerSurface, type LocalCommand, type QueueOutcome, useThreadSurface } from "../shell-slots.ts";

// biome-ignore lint: live and inbox docs are loosely typed JSON
type Any = any;

type Image = { data: string; mimeType: string; name: string };

type Command = LocalCommand;
/** A Pi Session's command list from its control, for one Session and control state (`for`). */
type PiCommands = { for: string; state: "loading" } | { for: string; state: "ready"; value: SlashCommands } | { for: string; state: "failed"; code: string; message: string };
/** An inline decision the composer asks for, with the draft kept. */
type Choice = { message: string; actions: { label: string; run: () => unknown }[] };
/** A submission on its way out: its intent records the busy mode and, once known, the request that carries it. */
type Sending = Draft<Image> & { intent: SendIntent };
/**
 * The one presenter of a returned submission's outcome (composer-drafts.ts): a held record, or a notice on text in the
 * draft. An uncertain outcome never reads as a refusal.
 */
function OutcomeLine({ outcome, keyed, held = false, what, actions }: { outcome: Outcome; keyed: boolean; held?: boolean; what?: ReactNode; actions: ReactNode }) {
	return (
		<div className={`composer-feedback outcome ${outcome.uncertain ? "uncertain" : "error"}${held ? " returned" : ""} quiet-scroll`} data-scrollbar="none" role="alert" data-outcome={outcome.uncertain ? "uncertain" : "refused"}>
			<span>{outcomeText(outcome, keyed)}{what && " "}{what}</span>
			{actions}
		</div>
	);
}

/** How the composer names a queued Pi message that left Pi's queue without delivery. */
const PI_OUTCOMES: Record<string, QueueOutcome> = {
	returned: { badge: "not sent", tone: "attn", note: "returned to Pi's input box", recover: "Put this text into the composer. Pi's input box still holds it, so clear one copy before you send." },
	dropped: { badge: "not sent", tone: "err", note: "dropped by Pi" },
	unknown: { badge: "unknown", tone: "", note: "Pi stopped reporting this message" },
};
const PI_TEXTS: NonNullable<ComposerSurface["texts"]> = {
	source: "Pi",
	unsupported: "Only in the Pi pane",
	refuseUnsupported: (name) => `/${name} works only in the Pi pane.`,
	noImages: "this Session has no live control socket, so AmPi cannot send images; paste them in the Pi pane",
};
const PI_NO_EDIT = "Pi cannot edit a queued message; Stop returns it to Pi's input box.";
/** A queue item's text; images and entries show as placeholders. */
const queueText = (item: PiQueuedItem): string => {
	const content = (item as Any).content;
	return typeof content === "string" ? content : Array.isArray(content) ? content.map((p: Any) => (p.type === "text" ? p.text : "[image]")).join(" ") : (item as Any).entry?.data?.title ?? (item as Any).entry?.kind ?? "…";
};

type ImageRejections = Parameters<typeof rejectionLine>[0];
function imageAdmissionLines(rejected: ImageRejections): string | undefined {
	const groups = new Map<string, ImageRejections[number][]>();
	for (const item of rejected) groups.set(item.reason, [...(groups.get(item.reason) ?? []), item]);
	const lines = [...groups].map(([reason, items]) => {
		const line = rejectionLine(items);
		return line && (reason.startsWith("over ") || reason.startsWith("limit "))
			? `${line}. Remove an image or send it in a separate message.`
			: line;
	});
	return lines.filter(Boolean).join("\n") || undefined;
}

function decodeImage(file: File): Promise<boolean> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const image = new window.Image();
		const finish = (readable: boolean) => { URL.revokeObjectURL(url); resolve(readable); };
		image.onload = () => finish(true);
		image.onerror = () => finish(false);
		image.src = url;
	});
}

function readImage(file: File): Promise<Image> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve({ data: String(reader.result).split(",")[1] ?? "", mimeType: file.type, name: file.name || "pasted image" });
		reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
		reader.readAsDataURL(file);
	});
}

function ContextMeter({ summary }: { summary?: ThreadSummary }) {
	const { id, open, setOpen, anchorProps, render } = useHoverCard<HTMLSpanElement>({ prefer: "above" });
	const window = summary?.contextWindow, used = summary?.contextTokens;
	const limit = summary?.workingBudget ?? window;
	const ratio = limit && used !== undefined ? used / limit : 0;
	return <span className="meter" {...anchorProps}>
		<button type="button" className="composer-card-trigger" tabIndex={0} aria-label="Context details" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(true)}>
			<span className={`bar ${ratio >= 1 ? "err" : ratio >= 0.85 ? "warn" : ""}`} aria-hidden="true"><div style={{ width: `${Math.max(0, Math.min(100, ratio * 100))}%`, minWidth: ratio > 0 ? 2 : 0 }} /></span>
			<span>{limit ? tokens(limit) : "—"}</span>
		</button>
		{render("Context details", <>
			<p>{used === undefined ? "Usage is not available." : `${used.toLocaleString()} tokens used${limit ? ` · ${Math.round(100 * ratio)}%` : ""}`}</p>
			{window && <p>Model window: {window.toLocaleString()} tokens</p>}
			{summary?.workingBudget !== undefined && <p>Working budget: {summary.workingBudget.toLocaleString()} tokens</p>}
		</>)}
	</span>;
}

function ComposerHelp({ hint, capability, choose }: { hint: string; capability: ImageLimits | string; choose: () => void }) {
	const { id, open, setOpen, anchorProps, render } = useHoverCard<HTMLSpanElement>({ prefer: "above" });
	return <span className="composer-help" {...anchorProps}>
		<button type="button" className="composer-card-trigger" tabIndex={0} aria-label="Composer help" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(true)}>?</button>
		{render("Composer help", <><p>{hint}</p><p>{typeof capability === "string" ? `Images unavailable: ${capability}` : "This model accepts images. Paste, drop or choose images."}</p>{typeof capability !== "string" && <button type="button" className="btn small" tabIndex={0} onClick={choose}>Choose images…</button>}</>)}
	</span>;
}

/**
 * Draft custody per Session (composer-drafts.ts): the draft with its images and request key, the messages that came
 * back unsent, and the draft's notices. Leaving a Session (Back, ⌘0, a switch) and coming back keeps them. Memory
 * only: a reload loses them.
 */
const CUSTODY = new Map<string, Custody<Image>>();
const draftListeners = new Set<() => void>();
function custodyOf(key: string): Custody<Image> {
	let custody = CUSTODY.get(key);
	if (!custody) CUSTODY.set(key, (custody = { draft: { text: "", images: [], key: newId() }, returned: [] }));
	return custody;
}
function updateCustody(key: string, next: (custody: Custody<Image>) => Custody<Image>) {
	const prev = custodyOf(key);
	const value = next(prev);
	if (value === prev) return;
	CUSTODY.set(key, value);
	for (const listener of draftListeners) listener();
}
function updateDraft(key: string, next: SetStateAction<string>) {
	updateCustody(key, (custody) => editDraft(custody, { text: typeof next === "function" ? next(custody.draft.text) : next }, newId));
}
/** A Session's draft custody, for a kind that moves a draft between Sessions (a fork). `undefined`: none yet. */
export const draftCustody = (host: string, threadId: string): Custody<Image> | undefined => CUSTODY.get(`${host}/${threadId}`);
export function setDraftCustody(host: string, threadId: string, custody: Custody<Image>): void {
	updateCustody(`${host}/${threadId}`, () => custody);
}
const subscribeDrafts = (listener: () => void) => {
	draftListeners.add(listener);
	return () => void draftListeners.delete(listener);
};

/** Appends a transcript quote, and an optional note, to a Session's draft, whether or not its composer is mounted. */
export function quoteDraft(host: string, threadId: string, selection: string, note: string) {
	updateDraft(`${host}/${threadId}`, (text) => appendDraftQuote({ text }, selection, note).text);
}

export type ComposerHandle = { quote: (text: string, note: string) => void };

export function Composer({
	host,
	threadId,
	view,
	summary,
	actions,
	composerRef,
}: {
	host: string;
	threadId: string;
	view: PiThreadView;
	summary?: ThreadSummary;
	/** The thread's open side panel, for a command that opens one. */
	actions?: { panel?: string; openPanel: (name: string) => void };
	/** ThreadView's handle: a transcript quote lands in this draft and focuses it. */
	composerRef?: Ref<ComposerHandle>;
}) {
	const draftKey = `${host}/${threadId}`;
	// This thread's kind fills the composer's slots; Pi fills none.
	const surface: ComposerSurface = useThreadSurface(host).composer ?? {};
	const texts = surface.texts ?? PI_TEXTS;
	const custody = useSyncExternalStore(subscribeDrafts, () => custodyOf(draftKey));
	const { text, images } = custody.draft;
	const { commandResult } = custody;
	const setText = (next: SetStateAction<string>) => updateDraft(draftKey, next);
	const setImages = (next: (prev: Image[]) => Image[]) => updateCustody(draftKey, (c) => editDraft(c, { images: next(c.draft.images) }, newId));
	// The Session on screen, none after unmount: a late outcome for a Session not on screen is held there with its
	// reason, never shown here.
	const showing = useRef<string | undefined>(draftKey);
	showing.current = draftKey;
	useEffect(() => {
		showing.current = draftKey;
		return () => { showing.current = undefined; };
	}, [draftKey]);
	/**
	 * Takes the draft as this submission's own content, key, and intent; the draft is empty under a new key. One draft
	 * yields at most one submission: a second activation in the same tick finds an empty draft, and an empty draft yields none.
	 */
	const take = (): Draft<Image> | undefined => {
		let submission = custodyOf(draftKey).draft;
		if (isEmpty(submission)) return undefined;
		updateCustody(draftKey, (c) => {
			const [next, taken] = takeDraft(c, newId());
			submission = taken;
			return next;
		});
		return submission;
	};
	const label = hostLabelFor(host, useHosts().hosts);
	/**
	 * A submission that failed comes back with its outcome: into an empty draft on screen, otherwise held beside it.
	 * Custody keeps the outcome, so it shows wherever and whenever the owner next sees the submission.
	 * `say`: false when a choice names the refusal instead.
	 */
	const returnSubmission = (submission: Draft<Image>, outcome: Outcome, say = true): string => {
		const id = newId();
		const hold = showing.current !== draftKey;
		updateCustody(draftKey, (c) => giveBack(c, submission, { id, outcome, newKey: newId, hold, quiet: !say }));
		return id;
	};
	/**
	 * A choice acts on the submission it was offered for: held, it leaves the returned list with its key and intent;
	 * restored, it is the draft.
	 */
	const reclaim = (id: string) => (): Draft<Image> | undefined => {
		const held = custodyOf(draftKey).returned.find((r) => r.id === id);
		if (!held) return take();
		updateCustody(draftKey, (c) => ({ ...c, returned: c.returned.filter((r) => r !== held) }));
		return held;
	};
	const [error, setError] = useState<string>();
	const [feedbackMaxHeight, setFeedbackMaxHeight] = useState(120);
	const [note, setNote] = useState<string>();
	const [pick, setPick] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [choice, setChoice] = useState<Choice>();
	const [piCommands, setPiCommands] = useState<PiCommands>();
	const ref = useRef<HTMLTextAreaElement>(null);
	const box = useRef<HTMLDivElement>(null);
	useImperativeHandle(composerRef, () => ({
		quote: (selection, quoteNote) => {
			quoteDraft(host, threadId, selection, quoteNote);
			// After React commits the new value: focus the draft with the caret at its end.
			requestAnimationFrame(() => {
				const el = ref.current;
				if (!el) return;
				el.focus();
				el.setSelectionRange(el.value.length, el.value.length);
			});
		},
	}), [host, threadId]);
	const fileInput = useRef<HTMLInputElement>(null);
	useLayoutEffect(() => {
		const update = () => {
			const region = document.querySelector<HTMLElement>('[data-region="composer"]') ?? document.documentElement;
			setFeedbackMaxHeight(Math.min(120, toCss(window.innerHeight * 0.3, region)));
		};
		update();
		window.addEventListener("resize", update);
		window.addEventListener("ampi:display", update);
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("ampi:display", update);
		};
	}, []);
	const busy = Boolean((view.live as Any)?.run);
	// Stop covers every live work kind of the thread: a run, and a compaction that runs without one.
	const stoppable = busy || Boolean((view.live as Any)?.compactions?.length);
	const queue = ((view.inbox as Any)?.items ?? []) as Any[];
	// A read-only thread keeps the draft and sends nothing.
	const readOnly = surface.readOnly?.(summary);
	const closed = readOnly !== undefined;
	// The slots' handle on this composer. Its members call functions defined below, at event time.
	const api: ComposerApi = {
		draftKey,
		say: (line) => setNote(line),
		fail: (e) => setError(hostErrorMessage(e, label)),
		prependDraft: (content) => recover(content),
		appendDraft: (content, outcome) => updateCustody(draftKey, (c) => appendDraftText(c, content, newId, outcome)),
		focus: () => ref.current?.focus(),
		panel: actions?.panel,
		openPanel: actions?.openPanel,
	};
	const place = { host, threadId, view, summary };
	// A Pi Session's commands come from its live control; reload when the Session or its control changes.
	const commandsFor = `${host}|${threadId}|${summary?.control ? "control" : "keys"}|${summary?.model ?? ""}`;
	const loaded = piCommands?.for === commandsFor ? piCommands : undefined;
	const known = useRef<{ model: string; value: SlashCommands }>(undefined);
	const modelFor = `${host}|${threadId}|${summary?.model ?? ""}`;
	if (known.current?.model !== modelFor) known.current = undefined;
	if (loaded?.state === "ready") known.current = { model: modelFor, value: loaded.value };
	const metadata = known.current?.value;
	const loadedRef = useRef(loaded);
	loadedRef.current = loaded;
	const wantsCommands = text.startsWith("/") && !text.startsWith("//");
	const commandsRequest = useRef<{ for: string; promise: Promise<PiCommands> }>(undefined);
	/** The list for this Session: the request in flight, or a new one after a failure. */
	const loadCommands = (refresh = false): Promise<PiCommands> => {
		const key = commandsFor;
		if (!refresh && commandsRequest.current?.for === key && loadedRef.current?.state !== "failed") return commandsRequest.current.promise;
		const promise = hub.request(host, "thread.commands", { threadId }).then(
			(value): PiCommands => ({ for: key, state: "ready", value }),
			(e: Error & { code?: string }): PiCommands => ({ for: key, state: "failed", code: e.code ?? "error", message: e.message }),
		);
		commandsRequest.current = { for: key, promise };
		setPiCommands({ for: key, state: "loading" });
		void promise.then((result) => {
			if (commandsRequest.current?.promise !== promise) return;
			loadedRef.current = result;
			setPiCommands(result);
		});
		return promise;
	};
	useEffect(() => {
		if ((wantsCommands || summary?.control) && (!loadedRef.current || loadedRef.current.state === "failed")) void loadCommands();
	}, [wantsCommands, commandsFor]);
	const wasBusy = useRef(false);
	useEffect(() => {
		if (busy && !wasBusy.current && summary?.control) void loadCommands(true);
		wasBusy.current = busy;
	}, [busy]);
	// Without a control the draft is typed into the pane, where Pi's TUI runs the command itself.
	const commandsHint = !wantsCommands || loaded?.state === "ready" ? undefined
		: !loaded || loaded.state === "loading" ? `Commands unavailable: loading the list from ${texts.source}…`
		: loaded.code === "no_control" ? "No control socket: Enter types a Pi command into the Pi pane's empty input box, and Pi runs it there"
		: loaded.code === "version_skew" ? loaded.message
		: `Commands unavailable: ${hostErrorMessage(loaded, label)}`;
	const local = surface.localCommands?.(place, api) ?? [];
	const discovered = loaded?.state === "ready" ? loaded.value.commands : [];
	const list: Command[] = [
		{ name: "stop", help: "Interrupt the current run or compaction (Esc)", run: () => abort() },
		...discovered
			.filter((c) => c.name !== "stop" && (c.supported || !local.some((action) => action.name === c.name)))
			.map((c) => ({ name: c.name, args: c.argsHint, help: c.supported ? (c.description ?? c.source) : texts.unsupported, disabled: !c.supported })),
		...local.filter((c) => c.name !== "stop" && !discovered.some((remote) => remote.name === c.name && remote.supported)),
	];
	// After `/model `, complete from the models this Pi can use and mark the current one.
	const modelRefs = loaded?.state === "ready" && /^\/model \S*$/.test(text)
		? loaded.value.models.map((m) => ({ name: `model ${m.ref}`, help: m.ref === loaded.value.model ? "current" : (m.name ?? "") }))
		: [];
	const menu: Command[] = [...list, ...modelRefs];
	const slash = /^\/(\S*)$/.exec(text) ?? (modelRefs.length ? /^\/(model \S*)$/.exec(text) : null);
	const matches = slash ? menu.filter((c) => c.name.toLowerCase().startsWith(slash[1]!.toLowerCase())) : [];
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
	// The Session's image capability, or why it has none. admitImages decides every offered file against it.
	const capability: ImageLimits | string = summary?.images
		?? (surface.texts ? texts.noImages
			: summary?.control ? "this model does not accept images"
			: PI_TEXTS.noImages);
	const takesImages = typeof capability !== "string";
	// --touch-fields is the one definition; read it again after mount and when the pointer media changes.
	const [touch, setTouch] = useState(touchFields);
	useLayoutEffect(() => {
		const read = () => setTouch(touchFields());
		read();
		const coarse = matchMedia("(pointer: coarse)");
		coarse.addEventListener("change", read);
		return () => coarse.removeEventListener("change", read);
	}, []);
	// Attached images plus files still being read, so two quick drops cannot both pass the same limit.
	const reading = useRef<{ base64: number }[]>([]);
	const attach = async (files: Iterable<File>) => {
		if (closed) return;
		const offered = [...files].map((file) => ({ file, name: file.name || "pasted image", type: file.type, base64: base64Length(file.size) }));
		const { accepted, rejected } = admitImages([...custodyOf(draftKey).draft.images.map((i) => ({ base64: i.data.length })), ...reading.current], offered, capability);
		setError(imageAdmissionLines(rejected));
		reading.current = [...reading.current, ...accepted];
		const read = await Promise.all(accepted.map(async (offered): Promise<{ image: Image } | { name: string }> => {
			if (!await decodeImage(offered.file)) return { name: offered.name };
			try { return { image: await readImage(offered.file) }; }
			catch { return { name: offered.name }; }
		}));
		reading.current = reading.current.filter((o) => !accepted.includes(o as (typeof accepted)[number]));
		const added = read.flatMap((result) => ("image" in result ? [result.image] : []));
		if (added.length) setImages((prev) => [...prev, ...added]);
		const failed = read.flatMap((result) => ("name" in result ? [result.name] : []));
		const unreadableLine = failed.length === 1
			? `${failed[0]} isn't a readable image, so it was not attached.`
			: failed.length > 1
				? `${failed.length} files aren't readable images, so they were not attached: ${failed.join(", ")}.`
				: undefined;
		setError([imageAdmissionLines(rejected), unreadableLine].filter(Boolean).join("\n"));
	};
	/** Runs a command of this page's list (ComposerSurface.localCommands); false when none has that name. */
	const runLocal = async (content: string): Promise<boolean> => {
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content);
		const command = match && list.find((c) => c.name === match[1]!.toLowerCase());
		if (!command?.run) return false;
		await command.run(match![2] ?? "");
		return true;
	};
	/** The choice sends only the submission it claims; a second click finds none. */
	const offerText = (message: string, whenBusy: "followUp" | "steer", claim: () => Draft<Image> | undefined) =>
		setChoice({
			message: `${message}. Nothing was sent.`,
			actions: [
				{ label: "Send as text", run: () => { const s = claim(); if (s) void dispatch(s, whenBusy, { literal: true }); } },
				{ label: "Edit", run: () => ref.current?.focus() },
			],
		});
	/**
	 * Runs one Host command as a typed op (A27). The send records its route before it awaits, so a retry under the same
	 * key repeats the same request. The draft clears only on a typed success.
	 */
	const runTyped = async (item: Sending, route: Extract<NonNullable<SendIntent["route"]>, { kind: "command" }>): Promise<void> => {
		const { name, args, abort: abortTurn } = route;
		const { whenBusy } = item.intent;
		item.intent.route = route;
		const ack = await hub.request(host, "thread.command", { threadId, name, ...(args ? { args } : {}), key: item.key, whenBusy, ...(abortTurn ? { abort: true } : {}) });
		// Say what the acknowledgement proves (D15): keys show only that the command was typed into the pane.
		const notice = ack.evidence === "sent" ? `Typed /${name} into the Pi pane (no receipt; its result shows there)` : ack.notice ?? (ack.disposition === "started" ? "Started a turn" : ack.disposition === "queued" ? "Queued" : `Sent /${name} to ${texts.source}`);
		let current = false;
		updateCustody(draftKey, (c) => {
			if (c.commandResult?.id !== item.key) return c;
			current = true;
			return { ...c, commandResult: { id: item.key, notice, ...((ack as { body?: string }).body ? { body: (ack as { body?: string }).body } : {}) } };
		});
		// A late answer for a Session not on screen acts only through its custody.
		if (showing.current !== draftKey) return;
		// A typed command can change the model or effort. Read current metadata before the chip shows it.
		commandsRequest.current = undefined;
		loadedRef.current = undefined;
		setPiCommands(undefined);
		if (summary?.control) void loadCommands(true);
		if (current) surface.onCommand?.(ack, api);
	};
	/**
	 * A slash submission: false when it is not a command. A command that this composer cannot send throws: code
	 * `command_choice` offers to send the text as a message instead. A `/name` never becomes a message here: only `//`
	 * and the owner's "Send as text" choice send slash text as a message.
	 */
	const hostCommand = async (item: Sending, content: string, abortTurn = false): Promise<boolean> => {
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content);
		if (!match && surface.hostDecidesSlash) return false;
		if (!match) throw Object.assign(new Error("No command name follows the /"), { code: "command_choice" });
		const name = match[1]!;
		if (name === "stop") {
			await abort();
			return true;
		}
		const route = { kind: "command" as const, name, args: match[2]?.trim() ?? "", ...(abortTurn ? { abort: true } : {}) };
		// Enter can come before the list arrives: wait for it, so a fast typist gets the same outcome. A failed list is
		// fetched again: the owner may have updated the control or started one since, and the kept draft must see it.
		const current = loadedRef.current?.state === "ready" ? loadedRef.current : await loadCommands();
		// No control, no list: the Host's agent types the command into the pane, where Pi's TUI runs it.
		if (current.state === "failed" && current.code === "no_control") {
			await runTyped(item, route);
			return true;
		}
		if (current.state !== "ready") {
			// A control of another build takes no op, so there is no text to offer either.
			if (current.state === "failed" && current.code === "version_skew") throw Object.assign(new Error(current.message), { code: "version_skew" });
			throw Object.assign(new Error(`Commands unavailable: ${current.state === "failed" ? current.message : `the list did not load from ${texts.source}`}`), { code: "unsupported" });
		}
		const known = current.value.commands.find((c) => c.name === name);
		if (known?.supported) await runTyped(item, route);
		else if (await runLocal(content)) return true;
		else if (!known) throw Object.assign(new Error(`${texts.source.replace(/^./, (c) => c.toUpperCase())} has no /${name} command`), { code: "command_choice" });
		else throw Object.assign(new Error(texts.refuseUnsupported(name)), { code: "unsupported" });
		return true;
	};
	/** Sends the draft; `command` replaces its text when Enter picks a partly typed slash command. */
	const send = async (whenBusy: "followUp" | "steer", command?: string) => {
		if (closed) return;
		if (command !== undefined) setText(command);
		// Take before any await: the draft is this submission's alone, and a second activation finds it empty.
		const submission = take();
		if (!submission) return;
		setError(undefined);
		setChoice(undefined);
		await dispatch(submission, whenBusy);
	};
	/**
	 * Sends one submission under its key. A retry follows the intent's route. A failure gives the submission back with
	 * its key and intent only when the outcome is unknown; a final refusal gives it back as a new message.
	 */
	const dispatch = async (submission: Draft<Image>, whenBusy: "followUp" | "steer", options: { literal?: boolean; abort?: boolean } = {}) => {
		const item: Sending = { ...submission, intent: submission.intent ? { ...submission.intent } : { whenBusy } };
		const { route } = item.intent;
		const content = item.text.trim();
		const plain = item.images.length === 0;
		// A command's answer belongs to the latest command sent: a retry under a new key shows its own answer.
		const command = route ? route.kind === "command" : !options.literal && plain && /^\/(?!\/)/.test(content);
		if (command) updateCustody(draftKey, (c) => ({ ...c, commandResult: { id: item.key } }));
		try {
			if (route?.kind === "command") await runTyped(item, route);
			else if (route?.kind === "message") await deliver(item, route.content, route.asText);
			else if (options.literal) await deliver(item, messageText(item.text, surface.literalText), true);
			else if (plain && content.startsWith("//")) await deliver(item, messageText(item.text, surface.literalText, true), true);
			else if (plain && content.startsWith("/") && (await hostCommand(item, content, options.abort))) { /* handled */ }
			else await deliver(item, messageText(item.text, surface.literalText));
		} catch (e) {
			const failure = e as Error & { code?: string };
			const { code } = failure;
			const outcome = sendOutcome(failure, label, !surface.deduplicates);
			// A typed refusal is a final reply under this key; only an unknown outcome keeps the key for a retry.
			// A choice names the refusal itself; every other refusal says its reason beside the returned draft.
			const offer = code === "command_choice" || (!surface.hostDecidesSlash && code === "unknown_command");
			const sent = item.intent.route;
			const compact = code === "busy" && sent?.kind === "command" && (sent.name === "compact" || (sent.name === "auto-compact" && /^run(?:\s|$)/.test(sent.args)));
			const claim = reclaim(returnSubmission(item, outcome, !(offer || compact)));
			if (offer) offerText(failure.message.replace(/\.$/, ""), item.intent.whenBusy, claim);
			else if (compact)
				setChoice({
					message: "Compact stops the running turn. Stop and compact?",
					actions: [
						{ label: "Stop and compact", run: () => { const s = claim(); if (s) void dispatch(s, item.intent.whenBusy, { abort: true }); } },
						{ label: "Cancel", run: () => ref.current?.focus() },
					],
				});
		}
	};
	/**
	 * Sends `content` with the submission's images under its key, and records the route first, so an escaped `//text`
	 * retries as the same request. `asText` marks slash text that the owner chose to send as a message.
	 */
	const deliver = async (item: Sending, content: string, asText?: true) => {
		item.intent.route = { kind: "message", content, ...(asText ? { asText } : {}) };
		const { images: sent } = item;
		const { whenBusy } = item.intent;
		const before = summary;
		const ack = await hub.request(host, "thread.submit", {
			threadId,
			content,
			whenBusy,
			requestId: item.key,
			...(asText ? { asText } : {}),
			...(sent.length ? { images: sent.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
		});
		if (surface.onSubmitted?.(ack, before, api)) return;
		// Say what the acknowledgement proves (D15): typed keys prove less than the control extension's admission.
		if (ack?.evidence) setNote(ack.evidence === "sent" ? "Typed into the pane (no admission receipt)" : ack.evidence === "started" ? "Started a turn" : whenBusy === "steer" ? "Steer admitted" : "Queued");
	};
	const abort = async () => {
		try {
			const ack = await hub.request(host, "thread.abort", { threadId });
			if (surface.onAbort?.(ack, api)) return;
			// Pi's abort puts queued input back into its editor draft and never sends it (O3).
			const returned = ack?.submissions?.filter((s) => s.state === "returned").length ?? 0;
			const lost = (ack?.submissions?.length ?? 0) - returned;
			const plural = (n: number) => (n === 1 ? "1 queued message" : `${n} queued messages`);
			// Pi returns text only: images of a returned message are lost.
			const images = ack?.submissions?.reduce((n, s) => n + (s.state === "returned" ? s.images ?? 0 : 0), 0) ?? 0;
			if (returned || lost) setNote(["Stopped", returned ? `${plural(returned)} returned to Pi's input box, not sent` : "", images ? `${images === 1 ? "1 image" : `${images} images`} lost` : "", lost ? `${plural(lost)} dropped by Pi` : ""].filter(Boolean).join("; "));
		} catch (e) {
			setError(hostErrorMessage(e as Error & { code?: string }, label));
		}
	};
	/** Moves a held message into the draft; images the Session cannot also take stay held, with the reason. */
	const restore = (id: string) => {
		const offered = (list: readonly Image[]) => list.map((image) => ({ image, name: image.name, type: image.mimeType, base64: image.data.length }));
		let line: string | undefined;
		updateCustody(draftKey, (c) => restoreReturned(c, id, (current, incoming) => {
			const { accepted, rejected } = admitImages(offered(current), offered(incoming), capability);
			line = rejectionLine(rejected);
			return { accepted: accepted.map((o) => o.image), rejected: rejected.map((r) => r.file.image) };
		}, newId));
		setError(line);
		ref.current?.focus();
	};
	// Puts a returned message into this composer; Pi's input box keeps its own copy, so nothing is sent twice by itself.
	const recover = (content: string) => {
		setText((prev) => [content, prev].filter((t) => t.trim()).join("\n\n"));
		ref.current?.focus();
	};
	const outcomes = surface.outcomes ?? PI_OUTCOMES;
	/** One queue item: an item names its outcome (P7), queued in the Host, or never sent and why. */
	const row = (item: PiQueuedItem) => {
		const content = queueText(item);
		const outcome = outcomes[item.state as string];
		return (
			<div className={`queue-item ${outcome ? "settled" : ""}`} key={item.id} title={outcome ? `${outcome.note}: ${content}` : content}>
				<span className={`badge ${outcome?.tone ?? ""}`}>{outcome ? outcome.badge : item.mode === "steer" ? "steer" : item.mode === "write" ? "note" : "queued"}</span>
				<span className="text">{content}</span>
				{outcome && <span className="outcome">{outcome.note}{item.state === "returned" && item.images ? `; its ${item.images === 1 ? "image is" : `${item.images} images are`} lost, attach again` : ""}</span>}
				{outcome?.recover && typeof item.content === "string" && (
					<button className="btn ghost small" title={outcome.recover} onClick={() => recover(item.content)}>
						Edit here
					</button>
				)}
				{item.state !== "queued" && (
					<button className="btn ghost small" title={outcome ? "Dismiss" : "Withdraw"} onClick={() => void hub.request(host, "thread.withdraw", { threadId, submissionId: String(item.id) }).catch((e) => setError(hostErrorMessage(e, label)))}>
						×
					</button>
				)}
			</div>
		);
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
			{surface.queue ? <surface.queue {...place} items={queue} row={row} api={api} /> : queue.length > 0 && (
				<div className="queue quiet-scroll" data-scrollbar="none">
					{queue.map(row)}
					{queue.some((item) => item.state === "queued" && (item.mode === "steer" || item.mode === "followUp")) && <div className="hint queue-hint">{PI_NO_EDIT}</div>}
				</div>
			)}
			{(matches.length > 0 || commandsHint) && (
				<Popover className="slash-menu quiet-scroll" role="listbox" data-slash-menu anchor={() => box.current?.getBoundingClientRect()} side="above" gap={8} fit owner={box.current}>
					{matches.map((c, i) => (
						<div
							key={c.name}
							role="option"
							aria-selected={i === pick}
							className={`slash-item ${i === pick ? "on" : ""}`}
							aria-disabled={c.disabled || undefined}
							style={c.disabled ? { opacity: 0.55 } : undefined}
							{...hoverIntent(() => setPick(i))}
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
				</Popover>
			)}
			{surface.banner && <surface.banner {...place} />}
			<div className="composer" ref={box} data-region="composer" tabIndex={-1}>
				{custody.returned.map((held) => (
					<OutcomeLine key={held.id} outcome={held.outcome} keyed={!!held.intent} held what={<>
						{held.text.trim() && <q>{held.text.trim().length > 80 ? `${held.text.trim().slice(0, 80)}…` : held.text.trim()}</q>}
						{held.images.length > 0 && ` with ${held.images.length === 1 ? "1 image" : `${held.images.length} images`}`}
					</>} actions={<>
						<button className="btn ghost small" title="Put this message back into the draft, ahead of what you typed since" onClick={() => restore(held.id)}>
							Restore
						</button>
						<button className="btn ghost small" title="Discard this message" onClick={() => updateCustody(draftKey, (c) => ({ ...c, returned: c.returned.filter((r) => r.id !== held.id) }))}>
							Discard
						</button>
					</>} />
				))}
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
					placeholder="Message the agent…"
					onChange={(e) => {
						setText(e.target.value);
						setChoice(undefined);
					}}
					onPaste={(e) => {
						const files = [...e.clipboardData.files];
						if (!files.length) return;
						// Mixed text and image paste keeps the text; a bare file paste adds no text.
						if (!e.clipboardData.types.includes("text/plain")) e.preventDefault();
						void attach(files);
					}}
					onKeyDown={(e) => {
						const whenBusy = composerSubmission({ key: e.key, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat, isComposing: e.nativeEvent.isComposing });
						if (matches.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
							e.preventDefault();
							setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
						} else if (matches.length > 0 && e.key === "Tab") {
							e.preventDefault();
							const c = matches[pick]!;
							setText(`/${c.name}${c.args ? " " : ""}`);
						} else if (whenBusy === "held") {
							e.preventDefault();
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
				{error && <div className="composer-feedback error image-admission-feedback quiet-scroll" style={{ maxHeight: feedbackMaxHeight }} role="alert">Your draft is kept; correct the issue and try again.{"\n"}{error}</div>}
				{readOnly}
				{custody.notices?.map((notice) => (
					<OutcomeLine key={notice.id} outcome={notice.outcome} keyed={noticeKeyed(custody.draft, notice)} actions={
						<button className="btn ghost small" onClick={() => updateCustody(draftKey, (c) => dismissNotice(c, notice.id))}>
							Dismiss
						</button>
					} />
				))}
				{commandResult?.notice && <div className="composer-feedback quiet-scroll" data-scrollbar="none" role="status" data-command-result>
					{commandResult.body ? <details key={commandResult.id}>
						<summary>{commandResult.body.split("\n")[0] || commandResult.notice}</summary>
						<div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{commandResult.body.split("\n").slice(1).join("\n")}</div>
					</details> : commandResult.notice}
					<button className="btn ghost small" onClick={() => updateCustody(draftKey, ({ commandResult: _dismissed, ...c }) => c)}>Dismiss</button>
				</div>}
				{note && !error && <div className="composer-feedback quiet-scroll" data-scrollbar="none" role="status">{note}</div>}
				{choice && (
					<div className="composer-feedback quiet-scroll" data-scrollbar="none" role="alert" data-command-choice>
						{choice.message}{" "}
						{choice.actions.map((a) => (
							<button key={a.label} className="btn small" onClick={() => (setChoice(undefined), void a.run())}>
								{a.label}
							</button>
						))}
					</div>
				)}
				{/* Help and battery keep fixed slots across run states. Draft attachments own their preview row. */}
				<div className="composer-bar">
					<ComposerHelp hint={composerHint({ busy, control: Boolean(summary?.control), images: takesImages, touch }, surface.hint)} capability={capability} choose={() => fileInput.current?.click()} />
					<input
						ref={fileInput}
						type="file"
						accept={takesImages ? capability.types.join(",") : undefined}
						multiple
						hidden
						onChange={(e) => {
							if (e.target.files) void attach([...e.target.files]);
							e.target.value = "";
						}}
					/>
					<ContextMeter summary={summary} />
					{surface.modelControl ? <surface.modelControl {...place} closed={closed} onOpen={() => void loadCommands(true)} /> : <ModelHudCard summary={summary} thinking={metadata?.thinking} thinkingLevels={metadata?.thinkingLevels} onOpen={() => void loadCommands(true)} />}
					<div className="composer-actions">
					{busy ? (
						<>
							<button className="btn small" aria-label="Queue" onClick={() => void send("followUp")} disabled={!text.trim() && images.length === 0} title="Queue a follow-up for when the agent finishes (Alt+Enter)">
								<span className="action-label">Queue</span>
							</button>
							<button className="btn small" aria-label="Steer ↵" onClick={() => void send("steer")} disabled={!text.trim() && images.length === 0} title="Steer: deliver after the current tool round (Enter)">
								<span className="action-label">Steer</span>
							</button>
							<button className="btn small danger" aria-label="■ Stop" onClick={abort} title="Interrupt (Esc)">
								<span className="action-label">Stop</span>
							</button>
						</>
					) : (
						<>
							<button className="btn primary small" aria-label="Send ↵" onClick={() => void send("steer")} disabled={closed || (!text.trim() && images.length === 0)}>
								<span className="action-label">Send</span>
							</button>
							{stoppable && (
								<button className="btn small danger" aria-label="■ Stop" onClick={abort} title="Cancel the compaction (Esc)">
									<span className="action-label">Stop</span>
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
