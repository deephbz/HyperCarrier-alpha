import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hostSetupPrompt } from "../../../src/shared/host-setup.ts";
import { findHost, hub, type HostState } from "../client.ts";
import { scaleOf } from "../display.ts";
import { MOD, go } from "../util.ts";
import { COMPOSER_KEYS, freshPress } from "../composer-keys.ts";
import { dispatchKeyAction, keyAvailable, KEYMAP, registerOverlay, type KeyBinding } from "../keymap.ts";
import type { Overlay } from "../focus.ts";
import { PAGES } from "../views/registry.ts";
import { carrier, navigate } from "../nav.ts";
import { href } from "../util.ts";
import { isPiHost, type HostThreads } from "./Sidebar.tsx";
import { FormRow } from "./FormRow.tsx";
import { hoverIntent } from "./Popover.tsx";
import { Segmented } from "./Segmented.tsx";
import { paletteSessions } from "./palette-sessions.ts";
import { proseRows, type HostProse, type ProseRow } from "./palette-prose.ts";
import type { ModelChoice } from "./ThreadView.tsx";
import { newId } from "../ids.ts";

/** The opener of the open Modal. A Modal opened from inside another (palette switching) inherits it. */
let modalOpener: HTMLElement | null = null;

export function Modal({ children, onClose, label = "AmPi dialog", overlay = "dialog" }: { children: React.ReactNode; onClose: () => void; label?: string; overlay?: Overlay }) {
	const ref = useRef<HTMLDivElement>(null);
	const active = document.activeElement as HTMLElement | null;
	const opener = useRef(active?.closest('[aria-modal="true"]') ? modalOpener : active);
	const close = useRef(onClose);
	close.current = onClose;
	const titleId = useId();
	// Every Modal gates global chords while it is open (focus R12), including Modals that App does not own.
	useLayoutEffect(() => registerOverlay(overlay), [overlay]);
	useLayoutEffect(() => {
		const modal = ref.current!;
		modalOpener = opener.current;
		const title = modal.querySelector("h2");
		if (title) { title.id = titleId; modal.setAttribute("aria-labelledby", titleId); }
		const controls = () => [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((el) => el.getClientRects().length > 0);
		if (!modal.contains(document.activeElement)) (controls()[0] ?? modal).focus({ preventScroll: true });
		const key = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); }
			if (e.key !== "Tab") return;
			const items = controls();
			const target = e.shiftKey ? items.at(-1) : items[0];
			if (!modal.contains(document.activeElement) || document.activeElement === modal || document.activeElement === (e.shiftKey ? items[0] : items.at(-1)) || !items.length) {
				e.preventDefault(); (target ?? modal).focus();
			}
		};
		document.addEventListener("keydown", key, true);
		let alertText: string | null = null;
		const revealError = () => {
			const alert = modal.querySelector<HTMLElement>('[role="alert"]');
			const text = alert?.textContent ?? null;
			if (text && text !== alertText) reveal(modal, alert!);
			alertText = text;
		};
		const observer = new MutationObserver(revealError);
		observer.observe(modal, { childList: true, characterData: true, subtree: true });
		const resize = new ResizeObserver(() => { alertText = null; revealError(); });
		resize.observe(modal);
		revealError();
		return () => {
			document.removeEventListener("keydown", key, true);
			observer.disconnect();
			resize.disconnect();
			if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
		};
	}, [titleId]);
	// Like a Popover, it renders in a body portal, outside every region's display zoom and every scroller.
	return createPortal(
		<div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div ref={ref} className="modal quiet-scroll" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
				{children}
			</div>
		</div>,
		document.body,
	);
}

/** Scrolls `item` into the view of `modal` only; `scrollIntoView` would also scroll the page's clipped ancestors. */
function reveal(modal: HTMLElement, item: HTMLElement) {
	const box = modal.getBoundingClientRect(), r = item.getBoundingClientRect();
	const by = r.top < box.top ? r.top - box.top : r.bottom > box.bottom ? Math.min(r.bottom - box.bottom, r.top - box.top) : 0;
	if (by) modal.scrollTop += by / scaleOf(modal);
}

const LAST_KEY = "ampi.newThread";

export function NewThreadDialog({
	hosts,
	defaultHost,
	onClose,
}: {
	hosts: HostState[];
	defaultHost?: string;
	onClose: () => void;
}) {
	const last = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as { host?: string; cwd?: Record<string, string>; model?: Record<string, string> };
	const connected = hosts.filter((h) => h.status === "connected");
	const [host, setHost] = useState(defaultHost ?? last.host ?? connected[0]?.id ?? "local");
	const [cwd, setCwd] = useState(last.cwd?.[host] ?? "");
	const [dirs, setDirs] = useState<{ path: string; parent: string; dirs: string[] }>();
	const [models, setModels] = useState<ModelChoice[]>([]);
	const [model, setModel] = useState(last.model?.[host] ?? "");
	const [prompt, setPrompt] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	// One ID per dialog: a double submit or a retry after a lost response finds the same thread.
	const [requestId] = useState(() => newId());
	useEffect(() => {
		setCwd(last.cwd?.[host] ?? "");
		setModel(last.model?.[host] ?? "");
		hub.request(host, "models.list").then(setModels, () => setModels([]));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [host]);
	useEffect(() => {
		const timer = setTimeout(() => {
			hub.request(host, "fs.dirs", { path: cwd }).then(setDirs, () => setDirs(undefined));
		}, 150);
		return () => clearTimeout(timer);
	}, [host, cwd]);
	const create = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const [provider, ...id] = model.split("/");
			const { threadId } = await hub.request(host, "thread.create", {
				cwd: dirs?.path ?? cwd,
				...(model ? { model: { provider, modelId: id.join("/") } } : {}),
				requestId,
				...(prompt.trim() ? { prompt: prompt.trim() } : {}),
			});
			localStorage.setItem(
				LAST_KEY,
				JSON.stringify({ host, cwd: { ...last.cwd, [host]: dirs?.path ?? cwd }, model: { ...last.model, [host]: model } }),
			);
			onClose();
			go(host, threadId);
		} catch (e) {
			setError((e as Error).message);
			setBusy(false);
		}
	};
	return (
		<Modal onClose={onClose}>
			<h2>New thread</h2>
			<div className="field">
				Host
				<select value={host} onChange={(e) => setHost(e.target.value)} aria-label="Host">
					{hosts.map((h) => (
						<option key={h.link} value={h.link} disabled={h.status !== "connected"}>
							{h.label} {h.node ? `(${h.node.hostname})` : `— ${h.status}`}
						</option>
					))}
				</select>
			</div>
			<div className="field">
				Working directory
				<input value={cwd} placeholder={dirs?.path ?? "~"} onChange={(e) => setCwd(e.target.value)} aria-label="Working directory" />
				{dirs && (
					<div className="dirlist quiet-scroll">
						<button onClick={() => setCwd(dirs.parent)}>..</button>
						{dirs.dirs.map((d) => (
							<button key={d} onClick={() => setCwd(`${dirs.path.replace(/\/$/, "")}/${d}`)}>
								{d}/
							</button>
						))}
					</div>
				)}
			</div>
			<div className="field">
				Model
				<select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
					<option value="">Host default</option>
					{models.map((m) => (
						<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
							{m.provider}/{m.id} {m.name !== m.id ? `— ${m.name}` : ""}
						</option>
					))}
				</select>
			</div>
			<div className="field">
				First message (optional)
				<textarea
					rows={3}
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					aria-label="First message"
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && freshPress(e.nativeEvent)) void create();
					}}
				/>
			</div>
			{error && <div className="err-box" role="alert">{error} Check the Host and directory, then retry. Your message is kept here.</div>}
			<div className="actions">
				<span className="hint" style={{ marginRight: "auto" }}>
					Runs on {findHost(hosts, host)?.node?.hostname ?? host}; nothing leaves that host but the view.
				</span>
				<button className="btn" onClick={onClose}>
					Cancel
				</button>
				<button className="btn primary" disabled={busy} onClick={() => void create()}>
					{busy ? "Creating…" : <>Create {MOD}↵</>}
				</button>
			</div>
		</Modal>
	);
}

/** "Remote host (?)": the copyable prompt an agent follows to add a remote Host. The window adds no Host itself. */
export function HostSetupDialog({ onClose }: { onClose: () => void }) {
	const [copied, setCopied] = useState<"ok" | "failed">();
	const prompt = hostSetupPrompt(hub.config);
	return (
		<Modal onClose={onClose}>
			<h2>Add a remote host</h2>
			<p className="hint" style={{ marginTop: 0 }}>
				Copy this prompt into a coding agent on this machine. The agent sets up SSH and the remote machine, adds the Host to{" "}
				<code>hub.json</code>, and restarts the hub. To remove a Host, delete its entry there and restart the hub.
			</p>
			<pre className="host-setup-prompt" style={{ whiteSpace: "pre-wrap", maxHeight: "40vh", overflow: "auto" }} data-host-setup>
				{prompt}
			</pre>
			{copied === "failed" && <div className="err-box" role="alert">The browser refused the copy. Select the text and copy it.</div>}
			<div className="actions">
				<button className="btn" onClick={onClose}>
					Close
				</button>
				<button
					className="btn primary"
					onClick={() => void navigator.clipboard.writeText(prompt).then(() => setCopied("ok"), () => setCopied("failed"))}
				>
					{copied === "ok" ? "Copied" : "Copy prompt"}
				</button>
			</div>
		</Modal>
	);
}

/** The ⌘K palette's two searches: Session names and titles (local), or prose in retained copies (each Pi Host's `sessions.search`). */
export type PaletteScope = "sessions" | "prose";
let lastScope: PaletteScope = "sessions";
const SCOPES = [["sessions", "Sessions"], ["prose", "Prose"]] as const;

export function Palette({ data, onClose, query = "", onQuery }: { data: HostThreads[]; onClose: () => void; query?: string; onQuery?: (query: string) => void }) {
	const [q, setQState] = useState(query);
	const setQ = (value: string) => { setQState(value); onQuery?.(value); };
	const [scope, setScopeState] = useState(lastScope);
	const setScope = (next: PaletteScope) => { lastScope = next; setScopeState(next); setIndex(0); };
	const [index, setIndex] = useState(0);
	const sessions = useMemo(() => paletteSessions(data, q), [data, q]);
	const piHosts = useMemo(() => data.filter((d) => isPiHost(d.host)).map((d) => d.host), [data]);
	const prose = useProseSearch(scope === "prose" ? q : "", piHosts);
	// The hub's hit title can be a raw thread id; the loaded Session list holds the title the sidebar shows.
	const titles = useMemo(() => new Map(data.flatMap((d) => d.threads.map((t) => [`${d.host.link}|${t.id}`, t.title] as const))), [data]);
	const count = scope === "sessions" ? sessions.length : prose.rows.length;
	const pick = (i: number) => {
		if (scope === "sessions") {
			const row = sessions[i];
			if (!row) return;
			onClose();
			go(row.host.link, row.t.id);
			return;
		}
		const row = prose.rows[i];
		if (!row) return;
		onClose();
		// The entry link takes the existing reveal path: the transcript scrolls to and opens the matching message.
		navigate(href.thread(row.host, row.threadId, { entry: row.entry }));
	};
	return (
		<Modal onClose={onClose} label="Search Sessions or prose" overlay="palette">
			<FormRow role="search" aria-label="Search Sessions or prose" field={
				<input
					className="search"
					aria-label="Find a Session"
					autoFocus
					placeholder={scope === "sessions" ? "Team, Worker, or Session name…" : "Words from your prompts or agent replies…"}
					value={q}
					maxLength={500}
					onChange={(e) => {
						setQ(e.target.value);
						setIndex(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							e.preventDefault();
							setIndex(Math.max(0, Math.min(count - 1, index + (e.key === "ArrowDown" ? 1 : -1))));
						} else if (e.key === "Enter") pick(index);
						else if (e.key === "Tab" && !e.altKey && !e.metaKey && !e.ctrlKey) {
							e.preventDefault();
							setScope(scope === "sessions" ? "prose" : "sessions");
						}
					}}
				/>
			}>
				<Segmented label="Search scope" value={scope} options={SCOPES} onChange={setScope} />
			</FormRow>
			<div className="quiet-scroll" style={{ marginTop: 8, maxHeight: "50vh", overflowY: "auto" }}>
				{scope === "sessions" && sessions.map(({ host, t }, i) => (
					<button key={`${host.link}|${t.id}`} className={`palette-item ${i === index ? "on" : ""}`} {...hoverIntent(() => setIndex(i))} onClick={() => pick(i)} title={t.title || "Untitled Session"}>
						<span className="palette-title" dir="auto">{t.team?.teamId ? `${t.team.teamId} / ${t.team.worker ?? "Lead"}` : t.title || "Untitled Session"}</span>
					</button>
				))}
				{scope === "sessions" && sessions.length === 0 && <div className="empty">{q.trim() ? "No Sessions match. Try a Team, Worker, or Session name." : "No Sessions yet."}</div>}
				{scope === "prose" && prose.rows.map((row, i) => (
					<button key={`${row.host}|${row.threadId}|${row.entry}`} className={`palette-item prose-hit ${i === index ? "on" : ""}`} data-target={href.thread(row.host, row.threadId, { entry: row.entry })} {...hoverIntent(() => setIndex(i))} onClick={() => pick(i)} title={row.title}>
						<span className="palette-title" dir="auto"><b>{titles.get(`${row.host}|${row.threadId}`) || row.title}</b>{piHosts.length > 1 ? <span className="hint"> · {row.hostLabel}</span> : null}<br /><span className="palette-snippet">{row.snippet}</span></span>
					</button>
				))}
				{scope === "prose" && prose.notes.map((note) => <div key={note} className="hint" role="status">{note}</div>)}
				{scope === "prose" && prose.rows.length === 0 && <div className="empty">{!q.trim() ? "Type words to search prose." : prose.busy ? "Searching…" : "No prose matches."}</div>}
			</div>
			<div className="palette-foot hint" title={scope === "prose" ? prose.scope : undefined}>
				↑↓ move · ↵ open · Tab {scope === "sessions" ? "Prose" : "Sessions"} · Esc close{scope === "prose" ? " · your prompts, agent replies and summaries; no tools or thinking" : ""}
			</div>
		</Modal>
	);
}

/** Searches each Pi Host's retained prose as the query settles; a newer query discards older answers. */
function useProseSearch(query: string, hosts: HostState[]): { rows: ProseRow[]; notes: string[]; scope?: string; busy: boolean } {
	const [state, setState] = useState<{ rows: ProseRow[]; notes: string[]; scope?: string; busy: boolean }>({ rows: [], notes: [], busy: false });
	const generation = useRef(0);
	const needle = query.trim();
	useEffect(() => {
		const token = ++generation.current;
		if (!needle) { setState({ rows: [], notes: [], busy: false }); return; }
		setState((s) => ({ ...s, busy: true }));
		const timer = setTimeout(() => {
			void Promise.all(hosts.map(async (host): Promise<HostProse> => {
				try { return { host, value: await hub.request(host.link, "sessions.search", { query: needle }) }; }
				catch (e) { return { host, error: String(e) }; }
			})).then((results) => { if (generation.current === token) setState({ ...proseRows(results), busy: false }); });
		}, 200);
		return () => clearTimeout(timer);
	}, [needle, hosts]);
	return state;
}

function bindingLabel(binding: KeyBinding) {
	const modifiers = [binding.meta ? MOD : binding.ctrl ? "Ctrl" : "", binding.alt ? "Alt" : "", binding.shift ? "Shift" : ""].filter(Boolean);
	const key = binding.code ? binding.code.replace(/^Key/, "").replace(/^Digit/, "").replace("Backslash", "\\").replace("BracketLeft", "[").replace("BracketRight", "]").replace("Equal", "+").replace("Minus", "-").replace("Slash", "?") : "No shortcut";
	return [...modifiers, key].join("+");
}

function appOnly(binding: KeyBinding) {
	return binding.id === "panel.toggle" || binding.id === "session.palette" || binding.id.startsWith("zoom.");
}

export const ONBOARDING_KEY = "ampi.onboarding.dismissed";

export function DisplayDialog({ onClose }: { onClose: () => void }) {
	const defaults = { overall: 1, sidebar: 1, transcript: 1, composer: 1, panel: 1 };
	const [values, setValues] = useState(() => ({ ...defaults, ...JSON.parse(localStorage.getItem("ampi.display") ?? "{}") }));
	const save = (next: typeof values) => {
		setValues(next);
		localStorage.setItem("ampi.display", JSON.stringify(next));
		document.documentElement.style.zoom = String(next.overall);
		for (const region of ["sidebar", "transcript", "composer", "panel"] as const) {
			const root = document.querySelector<HTMLElement>(`[data-region="${region}"]`);
			if (root) root.style.zoom = String(next[region]);
		}
		window.dispatchEvent(new Event("ampi:display"));
	};
	return <Modal onClose={onClose}><h2>Display</h2>{(["overall", "sidebar", "transcript", "composer", "panel"] as const).map((key) => <label className="field" key={key}>{key[0]!.toUpperCase() + key.slice(1)} text size · {Math.round(values[key] * 100)}%<input aria-label={`${key} display size`} type="range" min="0.7" max="1.6" step="0.05" value={values[key]} onChange={(e) => save({ ...values, [key]: Number(e.target.value) })} /><button className="btn small" onClick={() => save({ ...values, [key]: 1 })}>Reset</button></label>)}<div className="actions"><button className="btn primary" onClick={onClose}>Close</button></div></Modal>;
}


/** A palette action runs after the close commits, so its focus snapshot sees the opener, not the palette (focus.ts R2). */
const runAfterClose = (run: () => void) => requestAnimationFrame(run);

export function CommandPalette({ onClose, query: initialQuery = "", onQuery }: { onClose: () => void; query?: string; onQuery?: (query: string) => void }) {
	const [query, setQueryState] = useState(initialQuery);
	const setQuery = (value: string) => { setQueryState(value); onQuery?.(value); };
	const entries = [
		...PAGES.map((page) => ({ label: page.label, key: "", run: () => { navigate(href.page(page.name)); } })),
		// One row per action; an action with two chords (⌘L and ⌘\) lists both (focus R19).
		...KEYMAP.filter((entry, i, all) => entry.palette && keyAvailable(entry) && all.findIndex((other) => other.id === entry.id && other.palette) === i).map((entry) => ({
			label: entry.label,
			key: KEYMAP.filter((other) => other.id === entry.id && other.palette && keyAvailable(other)).map(bindingLabel).join(" "),
			run: () => dispatchKeyAction(entry.id, new KeyboardEvent("keydown")),
		})),
	].filter((entry) => entry.label.toLowerCase().includes(query.toLowerCase()));
	return <Modal onClose={onClose} label="Command palette" overlay="commands"><h2>Go to or run</h2><input autoFocus aria-label="Find a command" value={query} onChange={(e) => setQuery(e.target.value)} /><div className="palette-list">{entries.map((entry) => <button key={`${entry.label}:${entry.key}`} className="palette-item" onClick={() => { onClose(); runAfterClose(entry.run); }}><span>{entry.label}</span><span className="kbd">{entry.key}</span></button>)}</div><div className="actions"><button className="btn" onClick={() => { onClose(); runAfterClose(() => dispatchKeyAction("display", new KeyboardEvent("keydown"))); }}>Display settings</button></div></Modal>;
}

export function HelpDialog({ onClose }: { onClose: () => void }) {
	return (
		<Modal onClose={onClose} overlay="help">
			<h2>Keys and help</h2>
			<div data-help>
				{(["global", "sidebar", "transcript", "composer", "panel"] as const).map((region) => <section key={region}><h3>{region[0]!.toUpperCase() + region.slice(1)}</h3><div className="kbd-grid">{KEYMAP.filter((binding) => binding.region === region && (keyAvailable(binding) || binding.context)).map((binding, i) => <Fragment key={`${binding.id}:${binding.code}:${i}`}><span className="kbd">{bindingLabel(binding)}{appOnly(binding) ? " · app only" : ""}</span><span>{binding.label}{binding.note ? ` · ${binding.note}` : ""}{binding.appNote && carrier() === "app" ? ` · ${binding.appNote}` : ""}{keyAvailable(binding) ? "" : ` · ${binding.context}`}</span></Fragment>)}{region === "composer" && COMPOSER_KEYS.map(({ key, help }) => <Fragment key={key}><span className="kbd">{key}</span><span>{help}</span></Fragment>)}{region === "global" && <><Fragment><span className="kbd">Alt+↑ / Alt+↓</span><span>Previous or next Session</span></Fragment><Fragment><span className="kbd">Esc</span><span>Interrupt or close the current popup</span></Fragment></>}</div></section>)}
			</div>
			<p className="hint">
				In a terminal: <code>ampi doctor</code> checks this machine and every host and says how to fix what is missing;{" "}
				<code>ampi open</code> prints the link to this window with its access key.
			</p>
			<div className="actions">
				<button
					className="btn"
					onClick={() => {
						localStorage.removeItem(ONBOARDING_KEY);
						onClose();
						go();
					}}
				>
					Show the setup checklist
				</button>
				<button className="btn primary" onClick={onClose}>
					Close
				</button>
			</div>
		</Modal>
	);
}
