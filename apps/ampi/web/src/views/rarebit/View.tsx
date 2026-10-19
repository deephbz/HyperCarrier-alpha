import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RarebitFailure, RarebitItem, RarebitSide, RarebitValue } from "../../../../src/pi/views/rarebit.ts";
import { hub, useTopic } from "../../client.ts";
import { useKeepPlace } from "../../keep-place.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { clock, href, tokens } from "../../util.ts";
import { rarebitState, useRarebitState } from "./state.ts";
import { buildDetail, buildText } from "../cos/builds.ts";
import "./rarebit.css";

const MARK = { user: "□ You", continuation: "• Agent continues", stop: "● Agent stops", error: "× Terminal error", compaction: "Compacted" };
const GLYPH = { user: "", continuation: "•", stop: "●", error: "×" };
function Icon({ name }: { name: "copy" | "transcript" | "timeline" }) {
	const paths = { copy: "M8 8h11v12H8z M5 16H3V3h11v2", transcript: "M4 4h16v13H9l-5 4z M8 8h8 M8 12h6", timeline: "M4 20V4 M4 16h5v-5h5V6h6" };
	return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={paths[name]} /></svg>;
}
const time = (t: string | null) => (t && Number.isFinite(Date.parse(t)) ? clock(Date.parse(t)) : "—");
const messageTime = (t: string | null) => {
	if (!t || !Number.isFinite(Date.parse(t))) return "—";
	const date = new Date(t);
	return `${date.toDateString() === new Date().toDateString() ? "" : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · `}${time(t)}`;
};
const plain = (items: RarebitItem[]) => items.map((i) => i.kind === "compaction" ? `── compacted ${time(i.t)} · context restarts here ──` : `${MARK[i.kind]} ${time(i.t)}\n${i.text}`).join("\n\n");

function Copy({ text, label = "Copy", icon = false }: { text: string; label?: string; icon?: boolean }) {
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState(false);
	useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
	const feedback = error ? "Clipboard unavailable; select and copy the text instead" : copied ? "Copied" : label;
	return <button className={icon ? "btn ghost small rb-icon" : "btn ghost small"} aria-label={feedback} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setError(false); }, () => setError(true)); }} title={feedback}>{icon ? error ? "!" : copied ? "✓" : <Icon name="copy" /> : feedback}</button>;
}

export function RarebitView({ host, threadId, entry }: { host: string; threadId: string; entry?: string }) {
	const [before, setBefore] = useState<string>();
	useEffect(() => setBefore(undefined), [host, threadId]);
	const { value: result, stale, error } = useTopic<RarebitValue | RarebitFailure>(host, { kind: "view", view: "rarebit", threadId, ...(before ? { before } : {}) });
	const failure = result && "error" in result ? `${result.error.code}: ${result.error.message}` : error;
	const value = result && "items" in result ? result : undefined;
	const [state, set] = useRarebitState(host, threadId);
	const scroller = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const pinned = useRef(true);
	const keepPlace = useKeepPlace(scroller, "[data-rarebit]", "data-rarebit", pinned);
	const revealed = useRef<string | undefined>(undefined);
	const [settings, setSettings] = useState(false);
	const filtered = value?.items.filter((i) => !state.hide || i.kind !== "continuation") ?? [];
	// An automatic Arc update shows after the stop it followed: model spend the owner did not ask for stays visible.
	const builds = new Map<string, NonNullable<RarebitValue["arcBuilds"]>>();
	for (const b of value?.arcBuilds ?? []) if (b.afterEntryId) builds.set(b.afterEntryId, [...(builds.get(b.afterEntryId) ?? []), b]);
	const start = Math.max(0, filtered.length - state.window);
	const visible = filtered.slice(start, start + 60);
	const [steps, setSteps] = useState<{ prev?: number; next?: number }>({});
	const [jump, setJump] = useState<string>();
	const [tailSpace, setTailSpace] = useState(0);
	const updateSteps = () => {
		const el = scroller.current;
		if (!el) return;
		const top = el.getBoundingClientRect().top + 12;
		const users = Array.from(el.querySelectorAll<HTMLElement>(".rb-message[data-kind='user']")).map((node) => ({ index: filtered.findIndex((item) => item.id === node.dataset.rarebit), top: node.getBoundingClientRect().top }));
		const prev = users.filter((user) => user.top < top - 2).at(-1)?.index ?? filtered.findLastIndex((item, index) => index < start && item.kind === "user");
		const next = users.find((user) => user.top > top + 2)?.index ?? filtered.findIndex((item, index) => index >= start + visible.length && item.kind === "user");
		setSteps((old) => old.prev === prev && old.next === next ? old : { prev, next });
	};
	useLayoutEffect(updateSteps, [value, state.window, state.hide, state.side, state.pending, tailSpace]);
	useLayoutEffect(() => {
		const el = scroller.current;
		const target = jump && el?.querySelector<HTMLElement>(`[data-rarebit="${CSS.escape(jump)}"]`);
		if (!el || !target) return;
		const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12;
		const needed = Math.max(0, Math.ceil(el.clientHeight - (el.scrollHeight - tailSpace - top)));
		if (needed !== tailSpace) { setTailSpace(needed); return; }
		el.scrollTop = top;
		setJump(undefined);
		updateSteps();
	}, [jump, state.window, tailSpace]);
	const step = (index: number | undefined) => {
		if (index === undefined || index < 0) return;
		pinned.current = false;
		set({ window: Math.max(60, filtered.length - index) });
		setJump(filtered[index]!.id);
	};
	// Preserve the shared reading-place rule while remapping the bounded message window.
	const toggleHide = () => {
		const hide = !state.hide;
		const el = scroller.current;
		if (el && value && !pinned.current) {
			const anchor = keepPlace.capture({ accept: (node) => !hide || node.dataset.kind !== "continuation" });
			const next = value.items.filter((i) => !hide || i.kind !== "continuation");
			const index = anchor ? next.findIndex((i) => i.id === anchor.id) : -1;
			if (anchor && index >= 0) {
				const above = visible.findIndex((i) => i.id === anchor.id);
				set({ hide, window: Math.max(60, next.length - Math.max(0, index - Math.max(0, above))) });
				return;
			}
		}
		keepPlace.capture();
		set({ hide });
	};
	useLayoutEffect(() => { const el = scroller.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [value, state.side, state.pending, state.hide]);
	useEffect(() => {
		// A linked entry is revealed once; a later Hide/Show must not jump back to it.
		if (!entry || !value || revealed.current === entry) return;
		if (state.hide && value.items.some((i) => i.id === entry && i.kind === "continuation")) { set({ hide: false }); return; }
		const index = filtered.findIndex((i) => i.id === entry);
		if (index < 0) return;
		pinned.current = false;
		revealed.current = entry;
		set({ window: Math.max(60, filtered.length - index) });
		requestAnimationFrame(() => scroller.current?.querySelector(`[data-rarebit="${CSS.escape(entry)}"]`)?.scrollIntoView({ block: "center" }));
	}, [entry, Boolean(value), state.hide]);
	const run = async (op: string, args = {}) => hub.request(host, `view.rarebit.${op}`, { threadId, ...args });
	const ask = async () => {
		const current = rarebitState(host, threadId).get();
		const question = current.draft.trim();
		if (!question || current.pending) return;
		set({ pending: question, draft: "", error: undefined }); pinned.current = true;
		try {
			const result = await run("ask", { sideId: current.side?.id, question, model: current.model }) as { side: RarebitSide };
			set({ side: result.side, error: result.side.turns.at(-1)?.error });
		} catch (e) { set({ error: (e as Error).message, draft: question }); }
		finally { set({ pending: undefined }); input.current?.focus(); }
	};
	const end = async () => {
		try { await run("ask", { sideId: state.side?.id, end: true }); } catch (e) { set({ error: (e as Error).message }); }
		set({ side: undefined }); pinned.current = true; input.current?.focus();
	};
	const count = value ? value.stats.user + value.stats.continuation + value.stats.stop : 0;
	const hasSide = Boolean(state.side || state.pending);
	return <div className="rb-view">
		<header className="rb-header">
			<div className="rb-toolbar rb-panel-summary">
				<span className="rb-meta" title={`${count.toLocaleString()} messages: ${value?.stats.user ?? 0} human, ${value?.stats.continuation ?? 0} continuations, ${value?.stats.stop ?? 0} stops. Selected share of message prose excludes thinking and tool-call inputs. ${tokens(value?.stats.rarebitTokens ?? 0)} of ${tokens(value?.stats.totalTokens ?? 0)} estimated tokens.${state.hide ? ` ${value?.stats.continuation ?? 0} continuations hidden.` : ""}`}>□ {value?.stats.user ?? 0} • {value?.stats.continuation ?? 0} ● {value?.stats.stop ?? 0} · {value?.stats.ratio == null ? "—" : `${Math.round(value.stats.ratio * 100)}%`}</span>
				<button className="btn ghost small" title={`${state.hide ? "Show" : "Hide"} continuations`} aria-label={`${state.hide ? "Show" : "Hide"} continuations`} aria-pressed={state.hide} disabled={!value?.stats.continuation} onClick={toggleHide}>{state.hide ? "Show" : "Hide"} •</button>
				<Copy text={plain(value?.items ?? [])} label="Copy this page" icon />
				<button className="btn ghost small rb-icon" title="Diagnosis" aria-label="Diagnosis" aria-expanded={state.diagnosis} onClick={() => set({ diagnosis: !state.diagnosis })}>▥</button>
				<button className="btn ghost small rb-icon" title="Models" aria-label="Models" aria-expanded={settings} onClick={() => setSettings(!settings)}>⚙</button>
			</div>
			{settings && <div className="rb-models"><label>Side ask model<input value={state.model} placeholder="Default: anthropic/claude-sonnet-5-5" onChange={(e) => set({ model: e.target.value })} disabled={hasSide} /></label><label>Recap model<input value={state.recapModel} placeholder="Default: anthropic/claude-haiku-5-5" onChange={(e) => set({ recapModel: e.target.value })} /></label><p className="rb-meta">Runs isolated Pi on the hub. A side thread keeps its first model until End.</p></div>}
			{value?.source && value.source.state !== "ready" && <p className="rb-meta">Last indexed evidence · {new Date(value.source.asOf).toLocaleString()} · {value.source.state}</p>}
			{stale && value && <div className="rb-error" role="status">Last local copy · Host may be away. Reconnect the Host to see new messages.</div>}
			{failure && <div className="rb-error" role="alert">Rarebit: {failure} The panel retries when the Session changes.</div>}
		</header>
		<div className="rb-scroll" ref={scroller} onScroll={() => { keepPlace.onScroll(); if (tailSpace) pinned.current = false; updateSteps(); }}>
			{!value && !failure ? <p className="rb-state" role="status">Reading the Session…</p> : !count && !failure ? <p className="rb-state">No Rarebits yet. Human messages and agent prose appear here; tool traffic stays in the transcript.</p> : null}
			{entry && value && !value.items.some((i) => i.id === entry) && <p className="rb-state">This entry is outside this Rarebit page or is not selected. Read it in the transcript.</p>}
			{entry && hasSide && <p className="rb-state">End the side ask to return to the linked Rarebit.</p>}
			{!hasSide && <>
				<p className="rb-meta">Bounded conversation page · statistics cover the full copied branch.</p>
				{value?.more && <button className="btn small" onClick={() => { setBefore(value.items[0]?.id); set({ window: 60 }); }}>Earlier page</button>}
				{before && <button className="btn small" onClick={() => { setBefore(undefined); set({ window: 60 }); }}>Newest page</button>}
				{start > 0 && <button className="btn ghost small rb-earlier" onClick={() => { pinned.current = false; set({ window: state.window + 60 }); scroller.current?.scrollTo({ top: 0 }); }}>Show 60 earlier · {start.toLocaleString()} remaining</button>}
				{visible.map((item) => item.kind === "compaction" ? <div key={item.id} className="rb-compaction" data-rarebit={item.id}><a href={href.thread(host, threadId, { entry: item.id })}>── compacted {time(item.t)} · context restarts here ──</a>{item.t && <a className="rb-timeline" href={href.page("timeline", [], { host, thread: threadId, at: String(Date.parse(item.t)) })}>Timeline ↗</a>}</div> : <article key={item.id} className={`rb-message rb-${item.kind} ${item.id === entry ? "rb-target" : ""}`} data-rarebit={item.id} data-kind={item.kind}>
					<div className="rb-message-heading"><span aria-label={MARK[item.kind]} title={MARK[item.kind]}>{GLYPH[item.kind]}</span><time dateTime={item.t ?? undefined} title={item.t ?? "Time unavailable"}>{messageTime(item.t)}</time><span className="rb-item-actions"><Copy text={item.text} icon /><a className="rb-icon" title="Transcript" aria-label="Transcript" href={href.thread(host, threadId, { entry: item.id, panel: "rarebit" })}><Icon name="transcript" /></a>{item.t && <a className="rb-icon" title="Timeline" aria-label="Timeline" href={href.page("timeline", [], { host, thread: threadId, at: String(Date.parse(item.t)) })}><Icon name="timeline" /></a>}</span></div>
					<Markdown text={item.text} />{item.truncated && <p className="rb-meta">Preview shortened · open Transcript to read the source entry.</p>}
					{builds.get(item.id)?.map((b) => <p key={b.startedAt} className="cos-arc-build-row" data-state={b.state} title={buildDetail(b)}><span>{buildText(b)}</span><a href={href.page("arcs", [host, threadId])}>Arc ↗</a></p>)}
				</article>)}
				{start + 60 < filtered.length && <button className="btn ghost small rb-earlier" onClick={() => { pinned.current = false; set({ window: Math.max(60, state.window - 60) }); scroller.current?.scrollTo({ top: 0 }); }}>Show 60 newer</button>}
			</>}
			{!hasSide && tailSpace > 0 && <div aria-hidden="true" style={{ height: tailSpace, flex: "none" }} />}
			{hasSide && <section className="rb-side" aria-label="Side ask">
				<div className="rb-side-heading"><strong>Side ask</strong><button className="btn ghost small" disabled={Boolean(state.pending)} onClick={() => void end()}>End</button></div>
				<p className="rb-meta">{state.side ? `Snapshot of ${state.side.count.toLocaleString()} Rarebits at ${time(state.side.at)}` : "Freezing a snapshot of Rarebits…"} · nothing here enters the main Session.</p>
				{state.side && <p className="rb-meta">{state.side.model} · revision {state.side.revision}{state.side.omittedChars ? ` · newest ${state.side.included} included; ${state.side.omittedChars.toLocaleString()} leading characters omitted` : " · complete snapshot"}</p>}
				{state.side?.turns.map((turn, i) => <div key={i}><article className="rb-message rb-user"><div className="rb-message-heading">□ You · side ask</div><Markdown text={turn.question} /></article>{turn.answer && <article className="rb-message rb-stop"><div className="rb-message-heading">Answer · model-derived</div><Markdown text={turn.answer} /><Copy text={turn.answer} /></article>}{turn.error && <p className="rb-error" role="alert">No answer ({turn.error}). Ask again or End to discard the snapshot.</p>}</div>)}
				{state.pending && <><article className="rb-message rb-user"><div className="rb-message-heading">□ You · side ask</div><Markdown text={state.pending} /></article><p className="rb-state" role="status">Reading the Rarebits…</p></>}
			</section>}
		</div>
		<footer className="rb-footer">
			<div className="rb-toolbar">{hasSide && <span className="rb-meta">Temporary side thread</span>}<button className="btn ghost small" onClick={() => { pinned.current = false; setTailSpace(0); if (!hasSide) set({ window: filtered.length }); requestAnimationFrame(() => scroller.current?.scrollTo({ top: 0 })); }}>↑ Top</button><button className="btn ghost small" title="Previous user message" aria-label="Previous user message" disabled={hasSide || steps.prev === undefined || steps.prev < 0} onClick={() => step(steps.prev)}>Prev</button><button className="btn ghost small" title="Next user message" aria-label="Next user message" disabled={hasSide || steps.next === undefined || steps.next < 0} onClick={() => step(steps.next)}>Next</button><button className="btn ghost small" onClick={() => { pinned.current = true; setTailSpace(0); set({ window: 60 }); requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight })); }}>↓ Bottom</button></div>
			<form className="rb-ask" onSubmit={(e) => { e.preventDefault(); void ask(); }}><textarea ref={input} aria-label={state.side ? "Follow up on the side" : "Ask on the side"} placeholder={state.side ? "Follow up…" : "Ask on the side (Rarebits only)…"} rows={2} maxLength={20_000} value={state.draft} onChange={(e) => set({ draft: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(); } }} /><button className="btn" type="submit" disabled={!state.draft.trim() || Boolean(state.pending) || !count}>Ask</button></form>
		</footer>
	</div>;
}
