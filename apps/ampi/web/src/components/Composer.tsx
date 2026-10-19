import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UiThreadView } from "../../../src/node/projection.ts";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
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

type Command = { name: string; args?: string; help: string; run: (arg: string) => Promise<void> | void };

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
	view: UiThreadView;
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
				const { threadId: forked } = await hub.request<{ threadId: string }>(host, "thread.fork", { threadId, entryId: last.id });
				go(host, forked);
			},
		},
		{
			name: "new",
			args: "[prompt]",
			help: "Start a new thread in this directory with this model",
			run: async (arg) => {
				const agent = ctx.view.agent as Any;
				const { threadId: created } = await hub.request<{ threadId: string }>(host, "thread.create", {
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
	view: UiThreadView;
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
			request = hub.request<Extras>(host, "prompts.list", { cwd });
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
	const list: Command[] = pi
		? [{ name: "stop", help: "Interrupt the current run (Esc)", run: () => abort() }]
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
	const slash = /^\/(\S*)$/.exec(text);
	const matches = slash ? list.filter((c) => c.name.startsWith(slash[1]!.toLowerCase())) : [];
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
		if (!command) return false;
		setText("");
		try {
			await command.run(match![2] ?? "");
		} catch (e) {
			setText(content);
			setError((e as Error).message);
		}
		return true;
	};
	const send = async (whenBusy: "followUp" | "steer") => {
		const content = text.trim();
		if (!content && images.length === 0) return;
		setError(undefined);
		if (images.length === 0 && (await runCommand(content))) return;
		const sent = images;
		setText("");
		setImages([]);
		try {
			const ack = await hub.request<{ via?: string; evidence?: string }>(host, "thread.submit", {
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
			setText(content);
			setImages(sent);
			setError((e as Error).message);
		}
	};
	const abort = async () => {
		try {
			const ack = await hub.request<{ submissions?: { state: string }[] }>(host, "thread.abort", { threadId });
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
			{matches.length > 0 && (
				<div className="slash-menu" role="listbox" data-slash-menu>
					{matches.map((c, i) => (
						<div
							key={c.name}
							role="option"
							aria-selected={i === pick}
							className={`slash-item ${i === pick ? "on" : ""}`}
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
					<div className="hint slash-foot">Tab completes · other /words go to the agent as written</div>
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
									? "Message the agent… (Enter starts a turn, Shift+Enter adds a line)"
									: "Message the agent… (Enter types it into the Herdr pane, Shift+Enter adds a line)"
								: "Message the agent… (Enter sends, Shift+Enter adds a line, / for commands, paste or drop images)"
					}
					onChange={(e) => setText(e.target.value)}
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
							if (matches.length > 0 && !list.some((c) => `/${c.name}` === text.trim())) {
								const c = matches[pick]!;
								if (c.args) return setText(`/${c.name} `);
								void runCommand(`/${c.name}`);
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
