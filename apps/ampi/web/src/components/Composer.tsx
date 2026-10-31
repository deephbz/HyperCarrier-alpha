import { type ReactNode, type Ref, type SetStateAction, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ImageLimits, PiThreadView, SlashCommands, ThreadSummary } from "../../../src/shared/protocol.ts";
import { admitImages, base64Length, rejectionLine } from "../../../src/shared/image-admission.ts";
import { hub, useHosts } from "../client.ts";
import { composerHint, composerSubmission } from "../composer-keys.ts";
import { type Custody, type Draft, type Outcome, appendDraftQuote, editDraft, giveBack, isEmpty, outcomeText, restoreReturned, takeDraft } from "../composer-drafts.ts";
import { hostErrorMessage, refusalText, sendOutcome } from "../composer-outcomes.ts";
import { toCss, touchFields } from "../display.ts";
import { openAccounts } from "./Accounts.tsx";
import { ModelHudCard } from "./ModelHudCard.tsx";
import { Popover, hoverIntent } from "./Popover.tsx";
import { MOD, go, tokens } from "../util.ts";
import { hostLabelFor } from "./host-label.ts";
import type { ModelChoice } from "./ThreadView.tsx";
import { newId } from "../ids.ts";

// biome-ignore lint: live and inbox docs are loosely typed JSON
type Any = any;

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

type Image = { data: string; mimeType: string; name: string };

/** `follow`: the owner's own send goes to the newest end of the transcript and ends a pending reveal. */
export type ComposerActions = { openPanel: (name: string) => void; follow: () => void };

/** `disabled`: listed but not runnable from here. A Pi command has no `run`: the composer sends it as a typed op. */
type Command = { name: string; args?: string; help: string; disabled?: boolean; run?: (arg: string) => Promise<void> | void };
/** A Pi Session's command list from its control, for one Session and control state (`for`). */
type PiCommands = { for: string; state: "loading" } | { for: string; state: "ready"; value: SlashCommands } | { for: string; state: "failed"; code: string; message: string };
/** An inline decision the composer asks for, with the draft kept. */
type Choice = { message: string; actions: { label: string; run: () => unknown }[] };
/**
 * The one presenter of a returned submission's outcome (composer-drafts.ts), held beside the draft or in it. An
 * uncertain outcome never reads as a refusal.
 */
function OutcomeLine({ outcome, keyed, held }: { outcome: Outcome; keyed: boolean; held?: { what: ReactNode; actions: ReactNode } }) {
	return (
		<div className={`composer-feedback ${outcome.uncertain ? "uncertain" : "error"}${held ? " returned" : ""} quiet-scroll`} data-scrollbar="none" role="alert" data-outcome={outcome.uncertain ? "uncertain" : "refused"}>
			{held ? <><span>{outcomeText(outcome, keyed)} {held.what}</span>{held.actions}</> : outcomeText(outcome, keyed)}
		</div>
	);
}

type Extras = { prompts: { name: string; description: string; body: string }[]; skills: { name: string; description: string; path: string }[] };
/** How the composer names a queued Pi message that left Pi's queue without delivery. */
const OUTCOMES: Record<string, { badge: string; tone: string; note: string }> = {
	returned: { badge: "not sent", tone: "attn", note: "returned to Pi's input box" },
	dropped: { badge: "not sent", tone: "err", note: "dropped by Pi" },
	unknown: { badge: "unknown", tone: "", note: "Pi stopped reporting this message" },
};

const extrasCache = new Map<string, Promise<Extras>>();

/** pi's template arguments: $1…$9, $@ and $ARGUMENTS; arguments are appended when the template names none. */
export function expandTemplate(body: string, arg: string): string {
	const words = arg.trim() ? arg.trim().split(/\s+/) : [];
	let used = false;
	const out = body
		.replace(/\$ARGUMENTS|\$@/g, () => ((used = true), arg.trim()))
		.replace(/\$([1-9])/g, (_, n: string) => ((used = true), words[Number(n) - 1] ?? ""));
	return used || !arg.trim() ? out.trim() : `${out.trim()}\n\n${arg.trim()}`;
}

/**
 * Commands the composer runs itself. Any other `/word` goes to the agent unchanged, so prompt conventions that
 * start with a slash keep working.
 */
function commands(ctx: {
	host: string;
	threadId: string;
	view: PiThreadView;
	summary?: ThreadSummary;
	models: ModelChoice[];
	actions: ComposerActions;
	say: (text: string) => void;
}): Command[] {
	const { host, threadId } = ctx;
	return [
		{ name: "compact", help: "Compact the context now", run: () => hub.request(host, "thread.compact", { threadId }).then(() => {}) },
		{
			name: "model",
			args: "<name>",
			help: "Switch this thread's model",
			run: async (arg) => {
				const q = arg.trim().toLowerCase();
				const match = ctx.models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === q) ?? ctx.models.find((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q));
				if (!q || !match) throw new Error(q ? `No model matches “${arg.trim()}”` : `Models: ${ctx.models.map((m) => `${m.provider}/${m.id}`).join(", ")}`);
				await hub.request(host, "thread.configure", { threadId, model: { provider: match.provider, modelId: match.id } });
				ctx.say(`Model: ${match.provider}/${match.id}`);
			},
		},
		{
			name: "thinking",
			args: "<level>",
			help: "Set the thinking level",
			run: async (arg) => {
				const level = arg.trim();
				if (!THINKING.includes(level)) throw new Error(`Thinking levels: ${THINKING.join(", ")}`);
				await hub.request(host, "thread.configure", { threadId, thinkingLevel: level });
				ctx.say(`Thinking: ${level}`);
			},
		},
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
				const { threadId: created } = await hub.request(host, "thread.create", {
					cwd: agent?.cwd ?? ctx.summary?.cwd,
					...(agent?.model ? { model: agent.model } : {}),
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
		{ name: "shell", help: `Open the shell beside this thread (${MOD}J)`, run: () => ctx.actions.openPanel("shell") },
		{ name: "changes", help: "Show the files this thread changed", run: () => ctx.actions.openPanel("changes") },
		{ name: "team", help: "Show the Team and its Task graph", run: () => ctx.actions.openPanel("team") },
		{ name: "stop", help: "Interrupt the current run (Esc)", run: () => hub.request(host, "thread.abort", { threadId }).then(() => {}) },
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

/**
 * Draft custody per Session (composer-drafts.ts): the draft with its images and request key, and the messages that
 * came back unsent. Leaving a Session (Back, ⌘0, a switch) and coming back keeps them. Memory only: a reload loses them.
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
	updateCustody(key, (custody) => {
		const text = typeof next === "function" ? next(custody.draft.text) : next;
		return editDraft(custody, { text }, newId());
	});
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
	/** A Pi Session (D15): only messages, images through its live control, steer, queue, and interrupt; no node commands. */
	pi?: boolean;
	/** ThreadView's handle: a transcript quote lands in this draft and focuses it. */
	composerRef?: Ref<ComposerHandle>;
}) {
	const draftKey = `${host}/${threadId}`;
	const custody = useSyncExternalStore(subscribeDrafts, () => custodyOf(draftKey));
	const { text, images } = custody.draft;
	const setText = (next: SetStateAction<string>) => updateDraft(draftKey, next);
	const setImages = (next: (prev: Image[]) => Image[]) => updateCustody(draftKey, (c) => editDraft(c, { images: next(c.draft.images) }, newId()));
	// The Session on screen: a late outcome for another Session is held there with its reason, never shown here.
	const showing = useRef(draftKey);
	showing.current = draftKey;
	/**
	 * Takes the draft as this submission's own content and key; the draft is empty under a new key. One draft yields at
	 * most one submission: a second activation in the same tick finds an empty draft, and an empty draft yields none.
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
	/** A failed request's outcome: only a FINAL_REFUSAL code proves a refusal (composer-outcomes.ts). */
	const failed = (e: unknown): Outcome => sendOutcome(e as { code?: string; message: string }, label, pi);
	const refused = (message: string): Outcome => ({ uncertain: false, text: refusalText(message) });
	/**
	 * A submission that failed comes back with its outcome: into an empty draft on screen, otherwise held beside it.
	 * Custody keeps the outcome, so it shows wherever and whenever the owner next sees the submission.
	 * `say`: false when a choice names the refusal instead.
	 */
	const returnSubmission = (submission: Draft<Image>, outcome: Outcome, say = true): string => {
		const id = newId();
		const hold = showing.current !== draftKey;
		updateCustody(draftKey, (c) => giveBack(c, submission, { id, outcome, hold, quiet: !say }));
		return id;
	};
	/**
	 * A choice acts on the submission it was offered for: held, it leaves the returned list and keeps its retry key, if
	 * any; restored, it is the draft.
	 */
	const reclaim = (id: string) => (): Draft<Image> | undefined => {
		const held = custodyOf(draftKey).returned.find((r) => r.id === id);
		if (!held) return take();
		updateCustody(draftKey, (c) => ({ ...c, returned: c.returned.filter((r) => r !== held) }));
		return { text: held.text, images: held.images, key: held.retry ?? newId() };
	};
	const [error, setError] = useState<string>();
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
	const busy = Boolean((view.live as Any)?.run);
	const agent = view.agent as Any;
	const model = agent?.model ? `${agent.model.provider}/${agent.model.modelId}` : "";
	const realDefault = models.find((m) => m.default && m.provider !== "ampi-sim") ?? models.find((m) => m.provider !== "ampi-sim");
	const queue = ((view.inbox as Any)?.items ?? []) as Any[];
	const [extras, setExtras] = useState<Extras>({ prompts: [], skills: [] });
	const cwd = (view.agent as Any)?.cwd ?? summary?.cwd;
	/** This cwd's templates and skills: the request in flight or done, or a new one after a failure. */
	const loadExtras = (): Promise<Extras> => {
		const key = `${host}|${cwd}`;
		let request = extrasCache.get(key);
		if (!request) {
			request = hub.request(host, "prompts.list", { cwd });
			extrasCache.set(key, request);
			request.catch(() => extrasCache.delete(key));
		}
		return request;
	};
	useEffect(() => {
		if (pi) return;
		let live = true;
		loadExtras().then((r) => live && setExtras(r), () => {});
		return () => {
			live = false;
		};
	}, [host, cwd]);
	const submitText = (content: string) => {
		actions.follow();
		return hub.request(host, "thread.submit", { threadId, content, whenBusy: "followUp", requestId: newId() }).then(() => {});
	};
	const extraCommands = (loaded: Extras): Command[] => [
		...loaded.prompts.map((p) => ({ name: p.name, args: "[args]", help: `${p.description} (template)`, run: (arg: string) => submitText(expandTemplate(p.body, arg)) })),
		...loaded.skills.map((k) => ({
			name: `skill:${k.name}`,
			args: "[task]",
			help: k.description.length > 70 ? `${k.description.slice(0, 70)}…` : k.description,
			run: (arg: string) => submitText(`Use the ${k.name} skill (read ${k.path} first).${arg.trim() ? `\n\n${arg.trim()}` : ""}`),
		})),
	];
	// A Pi Session's commands come from its live control; reload when the Session or its control changes.
	const commandsFor = `${host}|${threadId}|${summary?.control ? "control" : "keys"}`;
	const loaded = piCommands?.for === commandsFor ? piCommands : undefined;
	const loadedRef = useRef(loaded);
	loadedRef.current = loaded;
	const wantsCommands = pi && text.startsWith("/") && !text.startsWith("//");
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
	const commandsHint = !wantsCommands || loaded?.state === "ready" ? undefined
		: !loaded || loaded.state === "loading" ? "Commands unavailable: loading the list from Pi…"
		: loaded.code === "no_control" ? "No control socket: Enter types a Pi command into the Pi pane's empty input box, and Pi runs it there"
		: loaded.code === "commands_unsupported" ? loaded.message
		: `Commands unavailable: ${loaded.message}`;
	const list: Command[] = pi
		? [
				{ name: "stop", help: "Interrupt the current run (Esc)", run: () => abort() },
				...(loaded?.state === "ready"
					? loaded.value.commands
							.filter((c) => c.name !== "stop")
							.map((c) => ({ name: c.name, args: c.argsHint, help: c.supported ? (c.description ?? c.source) : "Only in the Pi pane", disabled: !c.supported }))
					: []),
			]
		: [
		...commands({ host, threadId, view, summary, models, actions, say: setNote }),
		...extraCommands(extras),
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
		?? (!pi ? "this AmPi node is too old to take images; restart it"
			: summary?.control ? "this Pi Session cannot take images from AmPi yet: update pi-hc-control and /reload in the Pi pane"
			: "this Session has no live control socket, so AmPi cannot send images; paste them in the Pi pane");
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
		const offered = [...files].map((file) => ({ file, name: file.name || "pasted image", type: file.type, base64: base64Length(file.size) }));
		const { accepted, rejected } = admitImages([...custodyOf(draftKey).draft.images.map((i) => ({ base64: i.data.length })), ...reading.current], offered, capability);
		setError(rejectionLine(rejected));
		reading.current = [...reading.current, ...accepted];
		const read = await Promise.allSettled(accepted.map((o) => readImage(o.file)));
		reading.current = reading.current.filter((o) => !accepted.includes(o as (typeof accepted)[number]));
		const added = read.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
		setImages((prev) => [...prev, ...added]);
		const failed = read.flatMap((r, i) => (r.status === "rejected" ? [accepted[i]!.name] : []));
		if (failed.length) setError([rejectionLine(rejected), `${failed.join(", ")} could not be read`].filter(Boolean).join(" · "));
	};
	/**
	 * A non-Pi submission that starts with `/`: true when a composer command ran or the submission came back, false
	 * to send it to the agent unchanged. A name that is not built in waits for this cwd's templates and skills, so
	 * a `/template` typed before they arrive never goes out as text; without them the owner chooses.
	 */
	const runCommand = async (submission: Draft<Image>, content: string, whenBusy: "followUp" | "steer"): Promise<boolean> => {
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content);
		if (!match) return false;
		const name = match[1]!.toLowerCase();
		let command = list.find((c) => c.name === name);
		if (!command) {
			const loaded = await loadExtras().catch((e: Error) => e);
			if (loaded instanceof Error) {
				const message = `Templates and skills did not load (${loaded.message})`;
				offerText(content, message, whenBusy, reclaim(returnSubmission(submission, refused(message), false)));
				return true;
			}
			command = extraCommands(loaded).find((c) => c.name === name);
		}
		if (!command?.run) return false;
		try {
			await command.run(match![2] ?? "");
		} catch (e) {
			returnSubmission(submission, failed(e));
		}
		return true;
	};
	const offerText = (content: string, message: string, whenBusy: "followUp" | "steer", claim: () => Draft<Image> | undefined) =>
		setChoice({
			message: `${message}. Nothing was sent.`,
			actions: [
				{ label: "Send as text", run: () => sendClaimed(claim(), (s) => deliver(s, content, whenBusy, true)) },
				{ label: "Edit", run: () => ref.current?.focus() },
			],
		});
	/** Runs one Pi command as a typed control op (A27). The draft clears only on a typed success. */
	const runTyped = async (submission: Draft<Image>, content: string, name: string, args: string, whenBusy: "followUp" | "steer", abortTurn = false): Promise<void> => {
		try {
			const ack = await hub.request(host, "thread.command", { threadId, name, ...(args ? { args } : {}), key: submission.key, whenBusy, ...(abortTurn ? { abort: true } : {}) });
			// A command can change the list or the current model: load it again at the next `/`.
			commandsRequest.current = undefined;
			loadedRef.current = undefined;
			setPiCommands(undefined);
			// Say what the acknowledgement proves (D15): keys show only that the command was typed into the pane.
			setNote(ack.evidence === "sent" ? `Typed /${name} into the Pi pane (no receipt; its result shows there)` : ack.notice ?? (ack.disposition === "started" ? "Started a turn" : ack.disposition === "queued" ? "Queued" : `Sent /${name} to Pi`));
		} catch (e) {
			const { code, message } = e as Error & { code?: string };
			// A typed refusal is a final reply under this key; only an unknown outcome keeps the key for a retry.
			// A choice names the refusal itself; every other refusal says its reason beside the returned draft.
			const offer = code === "commands_unsupported" || code === "unknown_command";
			const claim = reclaim(returnSubmission(submission, failed(e), !(offer || (code === "busy" && name === "compact"))));
			if (code === "busy" && name === "compact")
				return setChoice({
					message: "Compact stops the running turn. Stop and compact?",
					actions: [
						{ label: "Stop and compact", run: () => sendClaimed(claim(), (s) => runTyped(s, content, name, args, whenBusy, true)) },
						{ label: "Cancel", run: () => ref.current?.focus() },
					],
				});
			if (offer) return offerText(content, message.replace(/\.$/, ""), whenBusy, claim);
		}
	};
	/**
	 * A Pi submission that starts with `/`: true when the composer handled it, false to send it as an ordinary message.
	 * A command that sends nothing gives the submission back with the reason. A `/name` never becomes a message here:
	 * only `//` and the owner's "Send as text" choice send slash text as a message.
	 */
	const piCommand = async (submission: Draft<Image>, content: string, whenBusy: "followUp" | "steer"): Promise<boolean> => {
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content);
		const offer = (message: string) => offerText(content, message, whenBusy, reclaim(returnSubmission(submission, refused(message), false)));
		if (!match) {
			offer("No command name follows the /");
			return true;
		}
		const name = match[1]!;
		if (name === "stop") {
			await abort();
			return true;
		}
		// Enter can come before the list arrives: wait for it, so a fast typist gets the same outcome. A failed list is
		// fetched again: the owner may have updated the control or started one since, and the kept draft must see it.
		const current = loadedRef.current?.state === "ready" ? loadedRef.current : await loadCommands();
		// No control, no list: the Host's agent types the command into the pane, where Pi's TUI runs it.
		if (current.state === "failed" && current.code === "no_control") {
			await runTyped(submission, content, name, match[2]?.trim() ?? "", whenBusy);
			return true;
		}
		if (current.state !== "ready") {
			if (current.state === "failed" && current.code === "commands_unsupported") offer(current.message.replace(/\.$/, ""));
			else returnSubmission(submission, refused(`Commands unavailable: ${current.state === "failed" ? current.message : "the list did not load from Pi"}`));
			return true;
		}
		const known = current.value.commands.find((c) => c.name === name);
		if (!known) offer(`Pi has no /${name} command`);
		else if (!known.supported) returnSubmission(submission, refused(`/${name} works only in the Pi pane`));
		else await runTyped(submission, content, name, match[2]?.trim() ?? "", whenBusy);
		return true;
	};
	/** A choice sends only the submission it claims; a second click finds none. */
	const sendClaimed = (submission: Draft<Image> | undefined, run: (submission: Draft<Image>) => Promise<void>) => (submission ? run(submission) : Promise.resolve());
	/** Sends the draft; `command` replaces its text when Enter picks a partly typed slash command. */
	const send = async (whenBusy: "followUp" | "steer", command?: string) => {
		// Take before any await: the draft is this submission's alone, and a second activation finds it empty.
		const submission = take();
		if (!submission) return;
		const content = (command ?? submission.text).trim();
		setError(undefined);
		setChoice(undefined);
		const plain = submission.images.length === 0;
		if (plain && pi && content.startsWith("//")) return deliver(submission, content.slice(1), whenBusy, true);
		if (plain && pi && content.startsWith("/") && (await piCommand(submission, content, whenBusy))) return;
		if (plain && !pi && (await runCommand(submission, content, whenBusy))) return;
		return deliver(submission, content, whenBusy);
	};
	/**
	 * Sends `content` with the submission's images under its key. A failure gives the submission back as typed, so an
	 * escaped `//text` stays escaped. It keeps its key only when the outcome is uncertain: a retry after a lost response
	 * is then placed once on the durable node. `asText` marks slash text that the owner chose to send as a message.
	 */
	const deliver = async (submission: Draft<Image>, content: string, whenBusy: "followUp" | "steer", asText = false) => {
		setError(undefined);
		actions.follow();
		const sent = submission.images;
		try {
			const ack = await hub.request(host, "thread.submit", {
				threadId,
				content,
				whenBusy,
				requestId: submission.key,
				...(asText ? { asText: true as const } : {}),
				...(sent.length ? { images: sent.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
			});
			// Say what the acknowledgement proves (D15): typed keys prove less than the control extension's admission.
			if (pi && ack?.evidence) setNote(ack.evidence === "sent" ? "Typed into the pane (no admission receipt)" : ack.evidence === "started" ? "Started a turn" : whenBusy === "steer" ? "Steer admitted" : "Queued");
		} catch (e) {
			returnSubmission(submission, failed(e));
		}
	};
	const abort = async () => {
		try {
			const ack = await hub.request(host, "thread.abort", { threadId });
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
		}, newId()));
		setError(line);
		ref.current?.focus();
	};
	// Puts a returned message into this composer; Pi's input box keeps its own copy, so nothing is sent twice by itself.
	const recover = (content: string) => {
		setText((prev) => [content, prev].filter((t) => t.trim()).join("\n\n"));
		ref.current?.focus();
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
						const content = typeof item.content === "string" ? item.content : Array.isArray(item.content) ? item.content.map((p: Any) => (p.type === "text" ? p.text : "[image]")).join(" ") : item.entry?.data?.title ?? item.entry?.kind ?? "…";
						// A Pi item names its outcome (P7): queued in Pi, or never sent and why.
						const outcome = OUTCOMES[item.state as string];
						return (
							<div className={`queue-item ${outcome ? "settled" : ""}`} key={item.id} title={outcome ? `${outcome.note}: ${content}` : content}>
								<span className={`badge ${outcome?.tone ?? ""}`}>{outcome ? outcome.badge : item.mode === "steer" ? "steer" : item.mode === "write" ? "note" : "queued"}</span>
								<span className="text">{content}</span>
								{outcome && <span className="outcome">{outcome.note}{item.state === "returned" && item.images ? `; its ${item.images === 1 ? "image is" : `${item.images} images are`} lost, attach again` : ""}</span>}
								{outcome && typeof item.content === "string" && (
									<button className="btn ghost small" title="Put this text into the composer. Pi's input box still holds it, so clear one copy before you send." onClick={() => recover(item.content)}>
										Edit here
									</button>
								)}
								{!(pi && item.state === "queued") && (
									<button className="btn ghost small" title={outcome ? "Dismiss" : "Withdraw"} onClick={() => void hub.request(host, "thread.withdraw", { threadId, submissionId: String(item.id) }).catch((e) => setError(hostErrorMessage(e, label)))}>
										×
									</button>
								)}
							</div>
						);
					})}
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
						{commandsHint ?? (pi ? "Tab completes · //text sends /text as a message" : "Tab completes · other /words go to the agent as written")}
					</div>
				</Popover>
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
			<div className="composer" ref={box} data-region="composer" tabIndex={-1}>
				{custody.returned.map((held) => (
					<OutcomeLine key={held.id} outcome={held.outcome} keyed={!!held.retry} held={{
						what: <>
							{held.text.trim() && <q>{held.text.trim().length > 80 ? `${held.text.trim().slice(0, 80)}…` : held.text.trim()}</q>}
							{held.images.length > 0 && ` with ${held.images.length === 1 ? "1 image" : `${held.images.length} images`}`}
						</>,
						actions: <>
							<button className="btn ghost small" title="Put this message back into the draft, ahead of what you typed since" onClick={() => restore(held.id)}>
								Restore
							</button>
							<button className="btn ghost small" title="Discard this message" onClick={() => updateCustody(draftKey, (c) => ({ ...c, returned: c.returned.filter((r) => r.id !== held.id) }))}>
								Discard
							</button>
						</>,
					}} />
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
					aria-label="Message the agent"
					placeholder={composerHint({ busy, pi, control: Boolean(summary?.control), images: takesImages, touch })}
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
						} else if (e.key === "Escape" && busy) {
							e.preventDefault();
							abort();
						}
					}}
				/>
				{error && <div className="composer-feedback error quiet-scroll" data-scrollbar="none" role="alert">{error} Your draft is kept; correct the issue and try again.</div>}
				{custody.notice && <OutcomeLine outcome={custody.notice} keyed={!!custody.draft.retry} />}
				{note && !error && !custody.notice && <div className="composer-feedback quiet-scroll" data-scrollbar="none" role="status">{note}</div>}
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
				<div className="composer-bar">
					{takesImages && (
					<button className="btn ghost small" title="Attach images (or paste or drop them)" onClick={() => fileInput.current?.click()}>
						＋ Image
					</button>
					)}
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
					{pi ? (
						summary?.model && <ModelHudCard summary={summary} />
					) : (
					<>
					<select
						value={model}
						title="Model"
						onChange={(e) => {
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
					</select>
					<select
						value={agent?.thinkingLevel ?? "medium"}
						title="Thinking level"
						onChange={(e) => void hub.request(host, "thread.configure", { threadId, thinkingLevel: e.target.value })}
					>
						{THINKING.map((level) => (
							<option key={level} value={level}>
								thinking: {level}
							</option>
						))}
					</select>
					</>
					)}
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
						<button className="btn primary small" onClick={() => void send("steer")} disabled={!text.trim() && images.length === 0}>
							Send ↵
						</button>
					)}
					</div>
				</div>
			</div>
		</div>
	);
}
