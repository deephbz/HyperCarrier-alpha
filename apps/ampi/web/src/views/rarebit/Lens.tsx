import { useEffect, useState, type ReactNode } from "react";
import { runClock, runDuration, type ToolRun } from "./tool-runs.ts";
import { useTopic } from "../../client.ts";
import { href } from "../../util.ts";
import { tokens } from "../../util.ts";
import { Diagnosis } from "./Diagnosis.tsx";
import { useRarebitState } from "./state.ts";
import { useRevealOpen } from "../../components/reveal-open.ts";
import { toggleArcPanel } from "../cos/ArcPanel.tsx";
import { Segmented, type Segment } from "../../components/Segmented.tsx";
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

const MODES: readonly Segment<"full" | "chat">[] = [
	["full", "Full", "Full transcript (L, ⌘T in AmPi.app, Ctrl+T in a browser)"],
	["chat", "Chat", "Conversation only (L, ⌘T in AmPi.app, Ctrl+T in a browser)"],
];

/** The Session header's Rarebit actions, inline in the bar or as items of its More menu (ThreadView's header fold). */
export function RarebitControls({ host, threadId, panel, setPanel, beforeLensChange, place }: { host: string; threadId: string; panel?: string; setPanel: (panel?: string) => void; beforeLensChange: () => void; place: "bar" | "menu" }) {
	const [state, set] = useRarebitState(host, threadId);
	const togglePanel = (name: string) => setPanel(panel === name ? undefined : name);
	const btn = place === "bar" ? "btn ghost small" : undefined;
	const mode = <Segmented label="Transcript mode" value={state.lens ? "chat" : "full"} options={MODES} onChange={(next) => { beforeLensChange(); set({ lens: next === "chat" }); }} />;
	const items = <>
		<button className={btn} aria-pressed={panel === "timeline"} onClick={() => togglePanel("timeline")}>Timeline</button>
		<button className={btn} aria-pressed={panel === "arc"} onClick={() => toggleArcPanel(panel, setPanel)}>Arc</button>
		{!panel && <a className={btn} href={href.thread(host, threadId, { panel: "rarebit" })}>Rarebit</a>}
	</>;
	return place === "bar" ? <span className="rb-controls">{mode}{items}</span> : <><div className="t-more-row"><span>Transcript</span>{mode}</div>{items}</>;
}

export function RarebitJump({ host, threadId, entry }: { host: string; threadId: string; entry: string }) {
	return <a className="rb-jump" tabIndex={-1} href={href.thread(host, threadId, { entry, panel: "rarebit" })} title="Show this message in the Rarebit panel" aria-label="Rarebit"><span className="rb-jump-label">Rarebit </span>↗</a>;
}

/** `reveal`: a reveal request for an entry in this run (ThreadView); each new request opens the fold. */
export function RarebitTools({ run, children, reveal }: { run: ToolRun; children: ReactNode; reveal?: number }) {
	const [held, setOpen] = useRevealOpen(reveal);
	const open = held ?? false;
	const last = run.entries.at(-1);
	const latest = last?.kind === "assistant" ? last.blocks.findLast((block) => block.type === "tool")?.name ?? "thinking" : last?.kind === "tool-result" ? last.name : last?.kind === "custom" ? last.entryKind : last?.kind;
	return <details className="rb-tools" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
		<summary className="quiet-scroll">{run.entries.map((entry, i) => run.entries.findIndex((e) => e.id === entry.id) === i && <span key={entry.id} data-entry={entry.id} data-fragment={`${run.keys[i]}/fold`} />)}{run.label} · {runDuration(run.start, run.end)} · {runClock(run.start)}–{runClock(run.end)}{run.errors > 0 && <span className="rb-run-errors"> · {run.errors} {run.errors === 1 ? "error" : "errors"}</span>}{run.running && ` · running · ${latest}`}</summary>
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
