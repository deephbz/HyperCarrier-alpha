import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { hub } from "../client.ts";
import { MOD, go } from "../util.ts";
import { COMPOSER_KEYS } from "../composer-keys.ts";
import { dispatchKeyAction, keyAvailable, KEYMAP, registerOverlay, type KeyBinding } from "../keymap.ts";
import type { Overlay } from "../focus.ts";
import { PAGES } from "../views/registry.ts";
import { carrier, navigate } from "../nav.ts";
import { href } from "../util.ts";
import type { HostThreads } from "./Sidebar.tsx";

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
			if (text && text !== alertText) alert?.scrollIntoView({ block: "nearest" });
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
	return (
		<div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div ref={ref} className="modal quiet-scroll" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
				{children}
			</div>
		</div>
	);
}

export function AddHostDialog({ onClose }: { onClose: () => void }) {
	const [target, setTarget] = useState("");
	const [label, setLabel] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const add = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await hub.hub("hosts.add", { target, label: label || target });
			onClose();
		} catch (e) {
			setError((e as Error).message);
			setBusy(false);
		}
	};
	return (
		<Modal onClose={onClose}>
			<h2>Add a remote host</h2>
			<p className="hint" style={{ marginTop: 0 }}>
				AmPi reaches remote nodes over SSH (key-based, non-interactive) and runs the bridge there. No port is opened on the remote host.
			</p>
			<div className="field">
				SSH destination
				<input value={target} placeholder="me@devbox or a Host alias" onChange={(e) => setTarget(e.target.value)} aria-label="SSH destination" />
			</div>
			<div className="field">
				Label
				<input value={label} placeholder="devbox" onChange={(e) => setLabel(e.target.value)} aria-label="Label" />
			</div>
			<p className="hint">
				The remote login runs <code>ampi bridge</code>, which starts that host's node if needed. A different command or
				SSH options go in <code>~/.ampi/hub.json</code>.
			</p>
			{error && <div className="err-box" role="alert">{error} Check the SSH destination and try again.</div>}
			<div className="actions">
				<button className="btn" onClick={onClose}>
					Cancel
				</button>
				<button className="btn primary" onClick={() => void add()} disabled={!target || busy}>
					{busy ? "Adding…" : "Add host"}
				</button>
			</div>
		</Modal>
	);
}

export function Palette({ data, onClose, query = "", onQuery }: { data: HostThreads[]; onClose: () => void; query?: string; onQuery?: (query: string) => void }) {
	const [q, setQState] = useState(query);
	const setQ = (value: string) => { setQState(value); onQuery?.(value); };
	const [index, setIndex] = useState(0);
	const rows = useMemo(() => {
		const all = data.flatMap((d) => d.threads.map((t) => ({ host: d.host, t })));
		const needle = q.trim().toLowerCase();
		const fields = (t: HostThreads["threads"][number]) => [t.team?.teamId ?? "", t.team?.worker ?? "", t.title ?? ""];
		const rank = (t: HostThreads["threads"][number]) => fields(t).reduce((best, value) => {
			const lower = value.toLowerCase();
			if (!needle || !lower.includes(needle)) return best;
			const at = lower.indexOf(needle);
			return Math.min(best, at === 0 ? 0 : /[\s/_-]$/.test(lower[at - 1] ?? "") ? 1 : 2);
		}, 3);
		return all.filter(({ t }) => rank(t) < 3).sort((a, b) => rank(a.t) - rank(b.t) || b.t.updatedAt - a.t.updatedAt).slice(0, 30);
	}, [data, q]);
	const pick = (i: number) => {
		const row = rows[i];
		if (!row) return;
		onClose();
		go(row.host.link, row.t.id);
	};
	return (
		<Modal onClose={onClose} label="Jump to a Session" overlay="palette">
			<input
				className="search"
				aria-label="Find a Session"
				autoFocus
				placeholder="Team, Worker, or Session name…"
				value={q}
				onChange={(e) => {
					setQ(e.target.value);
					setIndex(0);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						setIndex(Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1))));
					} else if (e.key === "Enter") pick(index);
				}}
			/>
			<div className="quiet-scroll" style={{ marginTop: 8, maxHeight: "50vh", overflowY: "auto" }}>
				{rows.map(({ host, t }, i) => (
					<button key={`${host.link}|${t.id}`} className={`palette-item ${i === index ? "on" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => pick(i)} title={t.title || "Untitled Session"}>
						<span className="palette-title" dir="auto">{t.team?.teamId ? `${t.team.teamId} / ${t.team.worker ?? "Lead"}` : t.title || "Untitled Session"}</span>
					</button>
				))}
				{rows.length === 0 && <div className="empty">No Sessions match. Try a title or directory.</div>}
			</div>
		</Modal>
	);
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
