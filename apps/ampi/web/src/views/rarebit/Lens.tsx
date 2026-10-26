import { useEffect, useState, type ReactNode } from "react";
import { runClock, runDuration, type ToolRun } from "./tool-runs.ts";
import { useTopic } from "../../client.ts";
import { href } from "../../util.ts";
import { tokens } from "../../util.ts";
import { Diagnosis } from "./Diagnosis.tsx";
import { useRarebitState } from "./state.ts";
import { toggleArcPanel } from "../cos/ArcPanel.tsx";
import "./rarebit.css";

export function useRarebitLens(host: string, threadId: string, pi: boolean, beforeChange: () => void) {
	const [state, set] = useRarebitState(host, threadId);
	useEffect(() => {
		if (!pi) return;
		const key = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() !== "l" || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
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
	</span>;
}

export function RarebitJump({ host, threadId, entry }: { host: string; threadId: string; entry: string }) {
	return <a className="rb-jump" tabIndex={-1} href={href.thread(host, threadId, { entry, panel: "rarebit" })} title="Show this message in the Rarebit panel">Rarebit ↗</a>;
}

export function RarebitTools({ run, children }: { run: ToolRun; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return <details className="rb-tools" onToggle={(e) => setOpen(e.currentTarget.open)}>
		<summary className="quiet-scroll">{run.entries.map((entry, i) => run.entries.findIndex((e) => e.id === entry.id) === i && <span key={entry.id} data-entry={entry.id} data-fragment={`${run.keys[i]}/fold`} />)}{run.label} · {runDuration(run.start, run.end)} · {runClock(run.start)}–{runClock(run.end)}{run.errors > 0 && <span className="rb-run-errors"> · {run.errors} {run.errors === 1 ? "error" : "errors"}</span>}{run.running && " · running"}</summary>
		{open && <div>{children}</div>}
	</details>;
}

export function RarebitBand({ host, threadId }: { host: string; threadId: string; lens: boolean }) {
	const [state, set] = useRarebitState(host, threadId);
	const { value: result, error } = useTopic(host, state.diagnosis ? { kind: "view", view: "rarebit", threadId } : undefined);
	const value = result && "items" in result ? result : undefined;
	if (!state.error && !state.diagnosis) return null;
	return <div className="rb-band quiet-scroll" aria-live="polite">
		{state.diagnosis && <section className="rb-band-diagnosis"><div className="rb-toolbar"><strong>Diagnosis</strong><button className="btn ghost small" onClick={() => set({ diagnosis: false })}>Dismiss diagnosis</button></div>{value ? <><p className="rb-meta">{value.stats.user + value.stats.continuation + value.stats.stop} Rarebits (□ {value.stats.user} · • {value.stats.continuation} · ● {value.stats.stop}) · {tokens(value.stats.rarebitTokens)} selected tokens</p><Diagnosis value={value} /></> : <p className="rb-meta">{result && "error" in result ? `Rarebit: ${result.error.message}` : error ?? "Reading the Session…"}</p>}</section>}
		{state.error && <div className="rb-error"><span>Rarebit: {state.error}</span><button className="btn ghost small" onClick={() => set({ error: undefined })}>Dismiss error</button></div>}
	</div>;
}
