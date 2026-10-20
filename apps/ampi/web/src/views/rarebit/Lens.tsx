import { useEffect, useState, type ReactNode } from "react";
import { runClock, runDuration, type ToolRun } from "./tool-runs.ts";
import type { RarebitFailure, RarebitRecap, RarebitValue } from "../../../../src/pi/views/rarebit.ts";
import { hub, useTopic } from "../../client.ts";
import { href } from "../../util.ts";
import { tokens } from "../../util.ts";
import { Diagnosis } from "./Diagnosis.tsx";
import { rarebitState, useRarebitState } from "./state.ts";
import { toggleArcPanel } from "../cos/ArcPanel.tsx";
import "./rarebit.css";

export async function writeRecap(host: string, threadId: string) {
	const store = rarebitState(host, threadId);
	if (store.get().recapping || store.get().checkingRecap) return;
	store.set({ checkingRecap: true, error: undefined });
	const args = { threadId, model: store.get().recapModel };
	try {
		let recap = await hub.request(host, "view.rarebit.recap", { ...args, cachedOnly: true });
		if (!recap) {
			store.set({ recapping: true });
			recap = await hub.request(host, "view.rarebit.recap", args);
		}
		store.set({ recap: recap ?? undefined, recapHidden: false });
	}
	catch (e) { store.set({ error: (e as Error).message }); }
	finally { store.set({ checkingRecap: false, recapping: false }); }
}

export function useRarebitLens(host: string, threadId: string, pi: boolean, beforeChange: () => void) {
	const [state, set] = useRarebitState(host, threadId);
	useEffect(() => {
		if (!pi) return;
		const key = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() !== "l" || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable], .xterm, [role=dialog]")) return;
			e.preventDefault(); beforeChange(); set({ lens: !state.lens });
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [pi, state.lens, host, threadId, beforeChange]);
	return pi && state.lens;
}

export function RarebitControls({ host, threadId, panel, setPanel, beforeLensChange }: { host: string; threadId: string; panel?: string; setPanel: (panel?: string) => void; beforeLensChange: () => void }) {
	const [state, set] = useRarebitState(host, threadId);
	const togglePanel = (name: string) => setPanel(panel === name ? undefined : name);
	return <span className="rb-controls">
		<button className={`btn small rb-lens ${state.lens ? "rb-lens-on" : "rb-lens-off"}`} aria-pressed={state.lens} aria-label={`Transcript lens: ${state.lens ? "conversation only" : "full transcript"}`} title={state.lens ? "Show full transcript (L)" : "Show conversation only (L)"} onClick={() => { beforeLensChange(); set({ lens: !state.lens }); }}>{state.lens ? "Conversation only" : "Full transcript"}</button>
		<button className="btn ghost small" aria-pressed={panel === "timeline"} onClick={() => togglePanel("timeline")}>Timeline</button>
		<button className="btn ghost small" aria-pressed={panel === "arc"} onClick={() => toggleArcPanel(panel, setPanel)}>Arc</button>
		{!panel && <a className="btn ghost small" href={href.thread(host, threadId, { panel: "rarebit" })}>Rarebit</a>}
		{/* A second click hides the shown recap; the next click shows it again from the hub's stored copy. */}
		<button className="btn ghost small" aria-pressed={Boolean(state.recap && !state.recapHidden)} disabled={state.recapping || state.checkingRecap} onClick={() => state.recap && !state.recapHidden ? set({ recapHidden: true }) : void writeRecap(host, threadId)}>Recap</button>
	</span>;
}

export function RarebitJump({ host, threadId, entry }: { host: string; threadId: string; entry: string }) {
	return <a className="rb-jump" tabIndex={-1} href={href.thread(host, threadId, { entry, panel: "rarebit" })} title="Show this message in the Rarebit panel">Rarebit ↗</a>;
}

export function RarebitTools({ run, children }: { run: ToolRun; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return <details className="rb-tools" onToggle={(e) => setOpen(e.currentTarget.open)}>
		<summary>{[...new Set(run.entries.map((entry) => entry.id))].map((id) => <span key={id} data-entry={id} />)}{run.label} · {runDuration(run.start, run.end)} · {runClock(run.start)}–{runClock(run.end)}{run.errors > 0 && <span className="rb-run-errors"> · {run.errors} {run.errors === 1 ? "error" : "errors"}</span>}{run.running && " · running"}</summary>
		{open && <div>{children}</div>}
	</details>;
}

export function RarebitBand({ host, threadId }: { host: string; threadId: string; lens: boolean }) {
	const [state, set] = useRarebitState(host, threadId);
	const { value: result, error } = useTopic(host, state.diagnosis ? { kind: "view", view: "rarebit", threadId } : undefined);
	const value = result && "items" in result ? result : undefined;
	const recapVisible = state.recap && !state.recapHidden;
	if (!recapVisible && !state.recapping && !state.error && !state.diagnosis) return null;
	return <div className="rb-band" aria-live="polite">
		{(state.recapping || recapVisible) && <div><span>{state.recapping ? "Writing recap…" : <>Since you left: {state.recap!.text} <small>Model-derived · {state.recap!.model}{state.recap!.omittedChars ? ` · ${state.recap!.omittedChars.toLocaleString()} leading characters omitted` : ""}</small>{state.recap!.entry && <a href={href.thread(host, threadId, { entry: state.recap!.entry })}>Evidence</a>}</>}</span><button className="btn ghost small" disabled={state.recapping} onClick={() => set({ recapHidden: true })}>Dismiss recap</button></div>}
		{state.diagnosis && <section className="rb-band-diagnosis"><div className="rb-toolbar"><strong>Diagnosis</strong><button className="btn ghost small" onClick={() => set({ diagnosis: false })}>Dismiss diagnosis</button></div>{value ? <><p className="rb-meta">{value.stats.user + value.stats.continuation + value.stats.stop} Rarebits (□ {value.stats.user} · • {value.stats.continuation} · ● {value.stats.stop}) · {tokens(value.stats.rarebitTokens)} selected tokens</p><Diagnosis value={value} /></> : <p className="rb-meta">{result && "error" in result ? `Rarebit: ${result.error.message}` : error ?? "Reading the Session…"}</p>}</section>}
		{state.error && <div className="rb-error"><span>Rarebit: {state.error}</span><button className="btn ghost small" onClick={() => set({ error: undefined })}>Dismiss error</button></div>}
	</div>;
}
