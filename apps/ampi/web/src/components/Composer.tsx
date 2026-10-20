import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PiThreadView, SlashCommands, ThreadSummary } from "../../../src/shared/protocol.ts";
import { hub } from "../client.ts";
import { COMPOSER_BUSY_HINT, composerSubmission } from "../composer-keys.ts";
import { openAccounts } from "./Accounts.tsx";
import { ModelHudCard } from "./ModelHudCard.tsx";
import { MOD, go, tokens } from "../util.ts";
import type { ModelChoice } from "./ThreadView.tsx";

// biome-ignore lint: live and inbox docs are loosely typed JSON
type Any = any;

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

type Image = { data: string; mimeType: string; name: string };
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ComposerActions = { openPanel: (name: string) => void };

/** `disabled`: listed but not runnable from here. A Pi command has no `run`: the composer sends it as a typed op. */
type Command = { name: string; args?: string; help: string; disabled?: boolean; run?: (arg: string) => Promise<void> | void };
/** A Pi Session's command list from its control, for one Session and control state (`for`). */
type PiCommands = { for: string; state: "loading" } | { for: string; state: "ready"; value: SlashCommands } | { for: string; state: "failed"; code: string; message: string };
/** An inline decision the composer asks for, with the draft kept. */
type Choice = { message: string; actions: { label: string; run: () => unknown }[] };
/** Outcomes that leave a command's result unknown: a retry reuses its key, so the control runs it at most once. */
const UNKNOWN_OUTCOME = new Set(["timeout", "control_unconfirmed"]);

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
		{ name: "summarize", help: "Write a Rarebit Summary now", run: () => (ctx.actions.openPanel("rarebit"), hub.request(host, "rarebit.summarize", { threadId }).then(() => {})) },
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

export function Composer({
	host,
	threadId,
	view,
	summary,
	models,
	actions,
	pi = false,
}: {
	host: string;
	threadId: string;
	view: PiThreadView;
	summary?: ThreadSummary;
	models: ModelChoice[];
	actions: ComposerActions;
	/** A Pi Session (D15): only messages, steer, queue, and interrupt; no models, images, or node commands. */
	pi?: boolean;
}) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<Image[]>([]);
	const [error, setError] = useState<string>();
	const [note, setNote] = useState<string>();
	const [pick, setPick] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [choice, setChoice] = useState<Choice>();
	const [piCommands, setPiCommands] = useState<PiCommands>();
	const ref = useRef<HTMLTextAreaElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	// One request ID per message the owner means to send: a retry after a lost response reuses it, so the node
	// places the message once.
	const intent = useRef<string>(crypto.randomUUID());
	const busy = Boolean((view.live as Any)?.run);
	const agent = view.agent as Any;
	const model = agent?.model ? `${agent.model.provider}/${agent.model.modelId}` : "";
	const realDefault = models.find((m) => m.default && m.provider !== "ampi-sim") ?? models.find((m) => m.provider !== "ampi-sim");
	const queue = ((view.inbox as Any)?.items ?? []) as Any[];
	const [extras, setExtras] = useState<Extras>({ prompts: [], skills: [] });
	const cwd = (view.agent as Any)?.cwd ?? summary?.cwd;
	useEffect(() => {
		if (pi) return;
		const key = `${host}|${cwd}`;
		let request = extrasCache.get(key);
		if (!request) {
			request = hub.request(host, "prompts.list", { cwd });
			extrasCache.set(key, request);
			request.catch(() => extrasCache.delete(key));
		}
		let live = true;
		request.then((r) => live && setExtras(r), () => {});
		return () => {
			live = false;
		};
	}, [host, cwd]);
	const submitText = (content: string) =>
		hub.request(host, "thread.submit", { threadId, content, whenBusy: "followUp", requestId: crypto.randomUUID() }).then(() => {});
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
		: loaded.code === "no_control" ? "No control socket: Enter types the command into the Pi pane, and Pi runs it there"
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
		...extras.prompts.map((p) => ({ name: p.name, args: "[args]", help: `${p.description} (template)`, run: (arg: string) => submitText(expandTemplate(p.body, arg)) })),
		...extras.skills.map((k) => ({
			name: `skill:${k.name}`,
			args: "[task]",
			help: k.description.length > 70 ? `${k.description.slice(0, 70)}…` : k.description,
			run: (arg: string) => submitText(`Use the ${k.name} skill (read ${k.path} first).${arg.trim() ? `\n\n${arg.trim()}` : ""}`),
		})),
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
		Object.assign(measure.style, { position: "fixed", visibility: "hidden", pointerEvents: "none", top: "0", left: "-10000px", width: `${el.getBoundingClientRect().width}px`, height: "0", minHeight: "0", maxHeight: "none" });
		el.parentElement!.append(measure);
		const height = measure.scrollHeight;
		measure.remove();
		el.style.height = `${Math.min(height, window.innerHeight * 0.4)}px`;
	}, [text]);
	const attach = async (files: Iterable<File>) => {
		setError(undefined);
		for (const file of files) {
			try {
				const image = await readImage(file);
				setImages((prev) => (prev.length >= 8 ? prev : [...prev, image]));
			} catch (e) {
				setError((e as Error).message);
			}
		}
	};
	const runCommand = async (content: string): Promise<boolean> => {
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content);
		const command = match && list.find((c) => c.name === match[1]!.toLowerCase());
		if (!command?.run) return false;
		setText("");
		try {
			await command.run(match![2] ?? "");
		} catch (e) {
			setText(content);
			setError((e as Error).message);
		}
		return true;
	};
	const offerText = (content: string, message: string, whenBusy: "followUp" | "steer") =>
		setChoice({
			message: `${message}. Nothing was sent.`,
			actions: [
				{ label: "Send as text", run: () => deliver(content, whenBusy) },
				{ label: "Edit", run: () => ref.current?.focus() },
			],
		});
	/** Runs one Pi command as a typed control op (A27). The draft clears only on a typed success. */
	const runTyped = async (content: string, name: string, args: string, whenBusy: "followUp" | "steer", abortTurn = false): Promise<void> => {
		setText("");
		try {
			const ack = await hub.request(host, "thread.command", { threadId, name, ...(args ? { args } : {}), key: intent.current, whenBusy, ...(abortTurn ? { abort: true } : {}) });
			intent.current = crypto.randomUUID();
			// A command can change the list or the current model: load it again at the next `/`.
			commandsRequest.current = undefined;
			loadedRef.current = undefined;
			setPiCommands(undefined);
			setNote(ack.notice ?? (ack.disposition === "started" ? "Started a turn" : ack.disposition === "queued" ? "Queued" : `Sent /${name} to Pi`));
		} catch (e) {
			const { code, message } = e as Error & { code?: string };
			setText(content);
			// A typed refusal is a final reply under this key; only an unknown outcome keeps the key for a retry.
			if (!code || !UNKNOWN_OUTCOME.has(code)) intent.current = crypto.randomUUID();
			if (code === "busy" && name === "compact")
				return setChoice({
					message: "Compact stops the running turn. Stop and compact?",
					actions: [
						{ label: "Stop and compact", run: () => runTyped(content, name, args, whenBusy, true) },
						{ label: "Cancel", run: () => ref.current?.focus() },
					],
				});
			if (code === "commands_unsupported") return offerText(content, message.replace(/\.$/, ""), whenBusy);
			if (code === "no_control") return void deliver(content, whenBusy);
			setError(message);
		}
	};
	/** A Pi draft that starts with `/`: true when the composer handled it, false to send it as an ordinary message. */
	const piCommand = async (content: string, whenBusy: "followUp" | "steer"): Promise<boolean> => {
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content);
		if (!match) return false;
		const name = match[1]!;
		if (name === "stop") {
			setText("");
			await abort();
			return true;
		}
		// Enter can come before the list arrives: wait for it, so a fast typist gets the same outcome. A failed list is
		// fetched again: the owner may have updated the control or started one since, and the kept draft must see it.
		const current = loadedRef.current?.state === "ready" ? loadedRef.current : await loadCommands();
		if (current.state === "failed" && current.code === "no_control") return false;
		if (current.state !== "ready") {
			if (current.state === "failed" && current.code === "commands_unsupported") offerText(content, current.message.replace(/\.$/, ""), whenBusy);
			else setError(`Commands unavailable: ${current.state === "failed" ? current.message : "the list did not load from Pi"}.`);
			return true;
		}
		const known = current.value.commands.find((c) => c.name === name);
		if (!known) offerText(content, `Pi has no /${name} command`, whenBusy);
		else if (!known.supported) setError(`/${name} works only in the Pi pane.`);
		else await runTyped(content, name, match[2]?.trim() ?? "", whenBusy);
		return true;
	};
	const send = async (whenBusy: "followUp" | "steer", draft = text) => {
		const content = draft.trim();
		if (!content && images.length === 0) return;
		setError(undefined);
		setChoice(undefined);
		if (images.length === 0 && pi && content.startsWith("//")) return deliver(content.slice(1), whenBusy, content);
		if (images.length === 0 && pi && content.startsWith("/") && (await piCommand(content, whenBusy))) return;
		if (images.length === 0 && !pi && (await runCommand(content))) return;
		return deliver(content, whenBusy);
	};
	/** Sends `content` as a message; a failure puts `draft` back, so an escaped `//text` stays escaped. */
	const deliver = async (content: string, whenBusy: "followUp" | "steer", draft = content) => {
		setError(undefined);
		const sent = images;
		setText("");
		setImages([]);
		try {
			const ack = await hub.request(host, "thread.submit", {
				threadId,
				content,
				whenBusy,
				requestId: intent.current,
				...(sent.length ? { images: sent.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
			});
			intent.current = crypto.randomUUID();
			// Say what the acknowledgement proves (D15): typed keys prove less than the control extension's admission.
			if (pi && ack?.evidence) setNote(ack.evidence === "sent" ? "Typed into the pane (no admission receipt)" : ack.evidence === "started" ? "Started a turn" : whenBusy === "steer" ? "Steer admitted" : "Queued");
		} catch (e) {
			setText(draft);
			setImages(sent);
			setError((e as Error).message);
		}
	};
	const abort = async () => {
		try {
			const ack = await hub.request(host, "thread.abort", { threadId });
			// Pi's abort puts queued input back into its editor draft and never sends it (O3).
			const returned = ack?.submissions?.filter((s) => s.state === "returned").length ?? 0;
			const lost = (ack?.submissions?.length ?? 0) - returned;
			const plural = (n: number) => (n === 1 ? "1 queued message" : `${n} queued messages`);
			if (returned || lost) setNote(["Stopped", returned ? `${plural(returned)} returned to Pi's input box, not sent` : "", lost ? `${plural(lost)} dropped by Pi` : ""].filter(Boolean).join("; "));
		} catch (e) {
			setError((e as Error).message);
		}
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
				<div className="queue">
					{queue.map((item) => {
						const content = typeof item.content === "string" ? item.content : Array.isArray(item.content) ? item.content.map((p: Any) => (p.type === "text" ? p.text : "[image]")).join(" ") : item.entry?.data?.title ?? item.entry?.kind ?? "…";
						// A Pi item names its outcome (P7): queued in Pi, or never sent and why.
						const outcome = OUTCOMES[item.state as string];
						return (
							<div className={`queue-item ${outcome ? "settled" : ""}`} key={item.id} title={outcome ? `${outcome.note}: ${content}` : content}>
								<span className={`badge ${outcome?.tone ?? ""}`}>{outcome ? outcome.badge : item.mode === "steer" ? "steer" : item.mode === "write" ? "note" : "queued"}</span>
								<span className="text">{content}</span>
								{outcome && <span className="outcome">{outcome.note}</span>}
								{outcome && typeof item.content === "string" && (
									<button className="btn ghost small" title="Put this text into the composer. Pi's input box still holds it, so clear one copy before you send." onClick={() => recover(item.content)}>
										Edit here
									</button>
								)}
								{!(pi && item.state === "queued") && (
									<button className="btn ghost small" title={outcome ? "Dismiss" : "Withdraw"} onClick={() => void hub.request(host, "thread.withdraw", { threadId, submissionId: String(item.id) }).catch((e) => setError(e.message))}>
										×
									</button>
								)}
							</div>
						);
					})}
				</div>
			)}
			{(matches.length > 0 || commandsHint) && (
				<div className="slash-menu" role="listbox" data-slash-menu>
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
						{commandsHint ?? (pi ? "Tab completes · //text sends /text as a message" : "Tab completes · other /words go to the agent as written")}
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
					value={text}
					rows={1}
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
						} else if (e.key === "Escape" && busy) {
							e.preventDefault();
							abort();
						}
					}}
				/>
				{error && <div className="composer-feedback error" role="alert">{error} Your draft is kept; correct the issue and try again.</div>}
				{note && !error && <div className="composer-feedback" role="status">{note}</div>}
				{choice && (
					<div className="composer-feedback" role="alert" data-command-choice>
						{choice.message}{" "}
						{choice.actions.map((a) => (
							<button key={a.label} className="btn small" onClick={() => (setChoice(undefined), void a.run())}>
								{a.label}
							</button>
						))}
					</div>
				)}
				<div className="composer-bar">
					{!pi && (
					<button className="btn ghost small" title="Attach images (or paste or drop them)" onClick={() => fileInput.current?.click()}>
						＋ Image
					</button>
					)}
					<input
						ref={fileInput}
						type="file"
						accept={IMAGE_TYPES.join(",")}
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
