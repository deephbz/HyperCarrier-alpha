import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RarebitFailure, RarebitItem, RarebitSide, RarebitValue } from "../../../../src/pi/views/rarebit.ts";
import { hub, useTopic } from "../../client.ts";
import { useKeepPlace } from "../../keep-place.ts";
import { revealStore } from "../../nav.ts";
import { toCss, toScreen } from "../../display.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { clock, href, tokens } from "../../util.ts";
import { freshPress } from "../../composer-keys.ts";
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

/** The reading line: a stepped-to message lands this many CSS px below the scroller's top. */
const READING_LINE = 12;

export function RarebitView({ host, threadId, entry }: { host: string; threadId: string; entry?: string }) {
	const [before, setBefore] = useState<string>();
	// A linked entry outside the loaded page: the hub serves the page that holds it until the reader pages away.
	const [around, setAround] = useState<string>();
	useEffect(() => { setBefore(undefined); setAround(undefined); }, [host, threadId]);
	const page = (cursor?: string) => { setAround(undefined); setBefore(cursor); };
	const { value: result, stale, error } = useTopic(host, { kind: "view", view: "rarebit", threadId, ...(around ? { around } : before ? { before } : {}) });
	// The reveal request for this Session's linked entry (nav.ts): each followed link asks again.
	const request = useSyncExternalStore(revealStore.subscribe, revealStore.get);
	const want = request && entry && request.thread === threadId && request.entry === entry ? request : undefined;
	const failure = result && "error" in result ? `${result.error.code}: ${result.error.message}` : error;
	const value = result && "items" in result ? result : undefined;
	const [state, set] = useRarebitState(host, threadId);
	const scroller = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const pinned = useRef(true);
	const keepPlace = useKeepPlace(scroller, "[data-rarebit]", "data-rarebit", pinned);
	/** The last reveal request this panel served; a later Hide/Show or page change does not jump back to it. */
	const revealed = useRef(0);
	const [settings, setSettings] = useState(false);
	const filtered = value?.items.filter((i) => !state.hide || i.kind !== "continuation") ?? [];
	// An automatic Arc update shows after the stop it followed: model spend the owner did not ask for stays visible.
	const builds = new Map<string, NonNullable<RarebitValue["arcBuilds"]>>();
	for (const b of value?.arcBuilds ?? []) if (b.afterEntryId) builds.set(b.afterEntryId, [...(builds.get(b.afterEntryId) ?? []), b]);
	const start = Math.max(0, filtered.length - state.window);
	const visible = filtered.slice(start, start + 60);
	const [steps, setSteps] = useState<{ prev?: number; next?: number }>({});
	/**
	 * A message to place `offset` CSS px below the scroller's top: a step lands on the reading line, a toggle keeps the
	 * read place. `hand` is the hook's hand-off; the reader's own scroll input before the write takes the place back.
	 * `space` is the tail space before the jump: a dropped jump leaves none of its own.
	 */
	const [jump, setJump] = useState<{ id: string; offset: number; hand: number; space: number }>();
	const [tailSpace, setTailSpace] = useState(0);
	/** Blank tail space shows only below the newest message; a window with newer messages behind it shows none. */
	const newest = start + 60 >= filtered.length;
	const tail = newest ? tailSpace : 0;
	// Tail space belongs to the jump that set it: a window or Hide change that places no message leaves none.
	useLayoutEffect(() => { if (!jump) setTailSpace(0); }, [state.window, state.hide]);
	const updateSteps = () => {
		const el = scroller.current;
		if (!el) return;
		const top = el.getBoundingClientRect().top + toScreen(READING_LINE, el);
		const users = Array.from(el.querySelectorAll<HTMLElement>(".rb-message[data-kind='user']")).map((node) => ({ index: filtered.findIndex((item) => item.id === node.dataset.rarebit), top: node.getBoundingClientRect().top }));
		const prev = users.filter((user) => user.top < top - 2).at(-1)?.index ?? filtered.findLastIndex((item, index) => index < start && item.kind === "user");
		const next = users.find((user) => user.top > top + 2)?.index ?? filtered.findIndex((item, index) => index >= start + visible.length && item.kind === "user");
		setSteps((old) => old.prev === prev && old.next === next ? old : { prev, next });
	};
	useLayoutEffect(updateSteps, [value, state.window, state.hide, state.side, state.pending, tailSpace]);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el || !jump) return;
		if (!keepPlace.holds(jump.hand)) { setJump(undefined); setTailSpace(jump.space); return; }
		const target = el.querySelector<HTMLElement>(`[data-rarebit="${CSS.escape(jump.id)}"]`);
		// The hook restores nothing while a jump waits; a target this window does not render leaves the place as it is.
		if (!target) { keepPlace.record(); return; }
		// Rects are screen px; scrollTop and the offset are the scroller's CSS px. The tail space below the window lets the
		// target reach its offset when too little content follows it.
		const top = toCss(target.getBoundingClientRect().top - el.getBoundingClientRect().top, el) + el.scrollTop - jump.offset;
		const short = Math.ceil(el.clientHeight - (el.scrollHeight - tail - top));
		// Newer messages fill the space instead. The window starts at the row the screen top will show, so the content above
		// the target still covers its offset; for a step, the target itself.
		const line = target.getBoundingClientRect().top - toScreen(jump.offset, el);
		const first = newest || short <= 0 ? undefined : [...el.querySelectorAll<HTMLElement>("[data-rarebit]")].findLast((row) => row.getBoundingClientRect().top <= line + 0.5);
		const index = first ? filtered.findIndex((item) => item.id === first.dataset.rarebit) : -1;
		if (index > start) { set({ window: Math.max(60, filtered.length - index) }); return; }
		const needed = newest ? Math.max(0, short) : 0;
		if (needed !== tailSpace) { setTailSpace(needed); return; }
		el.scrollTop = top;
		// The placed message is the reader's place at once: a resize before this write's scroll event restores it.
		keepPlace.record();
		setJump(undefined);
		updateSteps();
	}, [jump, state.window, tailSpace]);
	/** The one writer of a placed message: the hook hands the place to the jump effect. */
	const place = (id: string, offset: number) => setJump({ id, offset, hand: keepPlace.handOff(), space: tailSpace });
	const step = (index: number | undefined) => {
		if (index === undefined || index < 0) return;
		pinned.current = false;
		set({ window: Math.max(60, filtered.length - index) });
		place(filtered[index]!.id, READING_LINE);
	};
	// Preserve the shared reading-place rule while remapping the bounded message window. The remapped window can end a few
	// messages below the anchor, so the anchor is placed like a step, with newer messages or tail space under it.
	const toggleHide = () => {
		const hide = !state.hide;
		const el = scroller.current;
		if (el && value && !keepPlace.following()) {
			const anchor = keepPlace.measure({ accept: (node) => !hide || node.dataset.kind !== "continuation" });
			const next = value.items.filter((i) => !hide || i.kind !== "continuation");
			const index = anchor ? next.findIndex((i) => i.id === anchor.id) : -1;
			if (anchor && index >= 0) {
				const above = visible.findIndex((i) => i.id === anchor.id);
				set({ hide, window: Math.max(60, next.length - Math.max(0, index - Math.max(0, above))) });
				place(anchor.id, anchor.offset);
				return;
			}
		}
		keepPlace.capture();
		set({ hide });
	};
	useLayoutEffect(() => { if (keepPlace.following()) keepPlace.follow(); }, [value, state.side, state.pending, state.hide]);
	useEffect(() => {
		// Each reveal request is served once; a later Hide/Show must not jump back to it.
		if (!want || !value || revealed.current === want.seq) return;
		const entry = want.entry;
		if (!value.items.some((i) => i.id === entry)) {
			// Not on this page: ask the hub for the page that holds it, then stop once it says what the entry is. While the
			// Host indexes, each new value of the topic asks again.
			if (around !== entry) { page(); setAround(entry); return; }
			if (value.around?.id === entry && value.around.found !== "indexing") revealed.current = want.seq;
			return;
		}
		if (state.hide && value.items.some((i) => i.id === entry && i.kind === "continuation")) { set({ hide: false }); return; }
		const index = filtered.findIndex((i) => i.id === entry);
		if (index < 0) return;
		pinned.current = false;
		revealed.current = want.seq;
		set({ window: Math.max(60, filtered.length - index) });
		place(entry, READING_LINE);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [want?.seq, value, state.hide]);
	const ask = async () => {
		const current = rarebitState(host, threadId).get();
		const question = current.draft.trim();
		if (!question || current.pending) return;
		set({ pending: question, draft: "", error: undefined }); pinned.current = true;
		try {
			const result = await hub.request(host, "view.rarebit.ask", { threadId, sideId: current.side?.id, question, model: current.model });
			if (!("side" in result)) throw new Error("The side answer did not return its conversation");
			set({ side: result.side, error: result.side.turns.at(-1)?.error });
		} catch (e) { set({ error: (e as Error).message, draft: question }); }
		finally { set({ pending: undefined }); input.current?.focus(); }
	};
	const end = async () => {
		try { await hub.request(host, "view.rarebit.ask", { threadId, sideId: state.side?.id, end: true }); } catch (e) { set({ error: (e as Error).message }); }
		set({ side: undefined }); pinned.current = true; input.current?.focus();
	};
	const count = value ? value.stats.user + value.stats.continuation + value.stats.stop : 0;
	const hasSide = Boolean(state.side || state.pending);
	return <div className="rb-view">
		<header className="rb-header quiet-scroll">
			<div className="rb-toolbar rb-panel-summary">
				<span className="rb-meta" title={`${count.toLocaleString()} messages: ${value?.stats.user ?? 0} human, ${value?.stats.continuation ?? 0} continuations, ${value?.stats.stop ?? 0} stops. Selected share of message prose excludes thinking and tool-call inputs. ${tokens(value?.stats.rarebitTokens ?? 0)} of ${tokens(value?.stats.totalTokens ?? 0)} estimated tokens.${state.hide ? ` ${value?.stats.continuation ?? 0} continuations hidden.` : ""}`}>□ {value?.stats.user ?? 0} • {value?.stats.continuation ?? 0} ● {value?.stats.stop ?? 0} · {value?.stats.ratio == null ? "—" : `${Math.round(value.stats.ratio * 100)}%`}</span>
				<button className="btn ghost small" title={`${state.hide ? "Show" : "Hide"} continuations`} aria-label={`${state.hide ? "Show" : "Hide"} continuations`} aria-pressed={state.hide} disabled={!value?.stats.continuation} onClick={toggleHide}>{state.hide ? "Show" : "Hide"} •</button>
				<Copy text={plain(value?.items ?? [])} label="Copy this page" icon />
				<button className="btn ghost small rb-icon" title="Diagnosis" aria-label="Diagnosis" aria-expanded={state.diagnosis} onClick={() => set({ diagnosis: !state.diagnosis })}>▥</button>
				<button className="btn ghost small rb-icon" title="Models" aria-label="Models" aria-expanded={settings} onClick={() => setSettings(!settings)}>⚙</button>
			</div>
			{settings && <div className="rb-models"><label>Side ask model<input value={state.model} placeholder="Blank: the hub's rarebitAsk model" onChange={(e) => set({ model: e.target.value })} disabled={hasSide} /></label><p className="rb-meta">Runs isolated Pi on the hub. A side thread keeps its first model until End.</p></div>}
			{value?.source && value.source.state !== "ready" && <p className="rb-meta">Last indexed evidence · {new Date(value.source.asOf).toLocaleString()} · {value.source.state}</p>}
			{stale && value && <div className="rb-error" role="status">Last local copy · Host may be away. Reconnect the Host to see new messages.</div>}
			{failure && <div className="rb-error" role="alert">Rarebit: {failure} The panel retries when the Session changes.</div>}
		</header>
		<div className="rb-scroll quiet-scroll" ref={scroller} onScroll={() => { keepPlace.onScroll(); if (tail) pinned.current = false; updateSteps(); }}>
			{!value && !failure ? <p className="rb-state" role="status">Reading the Session…</p> : !count && !failure ? <p className="rb-state">No Rarebits yet. Human messages and agent prose appear here; tool traffic stays in the transcript.</p> : null}
			{entry && value && !value.items.some((i) => i.id === entry) && <p className="rb-state" data-why={value.around?.id === entry ? value.around.found : "page"}>{
				around === entry && value.around?.id !== entry ? "Loading the linked message's page…"
				: value.around?.id === entry && value.around.found === "entry" ? "The linked entry is tool traffic or a notice, not a Rarebit message. The transcript shows it."
				: value.around?.id === entry && value.around.found === "missing" ? "The linked entry is not on this Session's current branch."
				: value.around?.id === entry && value.around.found === "indexing" ? "The linked entry is not indexed yet. The panel shows it when indexing reaches it."
				: <>The linked message is outside this Rarebit page. <button className="link-button" onClick={() => { revealed.current = 0; setAround(entry); }}>Show it</button></>
			}</p>}
			{entry && hasSide && <p className="rb-state">End the side ask to return to the linked Rarebit.</p>}
			{!hasSide && <>
				<p className="rb-meta">Bounded conversation page · statistics cover the full copied branch.</p>
				{value?.more && <button className="btn small" onClick={() => { page(value.items[0]?.id); set({ window: 60 }); }}>Earlier page</button>}
				{(before || value?.before) && <button className="btn small" onClick={() => { page(); set({ window: 60 }); }}>Newest page</button>}
				{start > 0 && <button className="btn ghost small rb-earlier" onClick={() => { pinned.current = false; set({ window: state.window + 60 }); scroller.current?.scrollTo({ top: 0 }); }}>Show 60 earlier · {start.toLocaleString()} remaining</button>}
				{visible.map((item) => item.kind === "compaction" ? <div key={item.id} className="rb-compaction" data-rarebit={item.id}><a href={href.thread(host, threadId, { entry: item.id })}>── compacted {time(item.t)} · context restarts here ──</a>{item.t && <a className="rb-timeline" href={href.page("timeline", [], { host, thread: threadId, at: String(Date.parse(item.t)) })}>Timeline ↗</a>}</div> : <article key={item.id} className={`rb-message rb-${item.kind}${item.kind === "user" ? " you" : ""}${item.id === entry ? " rb-target" : ""}`} data-rarebit={item.id} data-kind={item.kind}>
					<div className={item.kind === "user" ? "rb-message-heading you-label" : "rb-message-heading"}><span aria-label={MARK[item.kind]} title={MARK[item.kind]}>{GLYPH[item.kind]}</span><time dateTime={item.t ?? undefined} title={item.t ?? "Time unavailable"}>{messageTime(item.t)}</time><span className="rb-item-actions"><Copy text={item.text} icon /><a className="rb-icon" title="Transcript" aria-label="Transcript" href={href.thread(host, threadId, { entry: item.id, panel: "rarebit" })}><Icon name="transcript" /></a>{item.t && <a className="rb-icon" title="Timeline" aria-label="Timeline" href={href.page("timeline", [], { host, thread: threadId, at: String(Date.parse(item.t)) })}><Icon name="timeline" /></a>}</span></div>
					<Markdown text={item.text} />{item.truncated && <p className="rb-meta">Preview shortened · open Transcript to read the source entry.</p>}
					{builds.get(item.id)?.map((b) => <p key={b.startedAt} className="cos-arc-build-row" data-state={b.state} title={buildDetail(b)}><span>{buildText(b)}</span><a href={href.page("arcs", [host, threadId])}>Arc ↗</a></p>)}
				</article>)}
				{!newest && <button className="btn ghost small rb-earlier" onClick={() => { pinned.current = false; set({ window: Math.max(60, state.window - 60) }); scroller.current?.scrollTo({ top: 0 }); }}>Show 60 newer</button>}
			</>}
			{!hasSide && tail > 0 && <div aria-hidden="true" style={{ height: tail, flex: "none" }} />}
			{hasSide && <section className="rb-side" aria-label="Side ask">
				<div className="rb-side-heading"><strong>Side ask</strong><button className="btn ghost small" disabled={Boolean(state.pending)} onClick={() => void end()}>End</button></div>
				<p className="rb-meta">{state.side ? `Snapshot of ${state.side.count.toLocaleString()} Rarebits at ${time(state.side.at)}` : "Freezing a snapshot of Rarebits…"} · nothing here enters the main Session.</p>
				{state.side && <p className="rb-meta">{state.side.model} · revision {state.side.revision}{state.side.omittedChars ? ` · newest ${state.side.included} included; ${state.side.omittedChars.toLocaleString()} leading characters omitted` : " · complete snapshot"}</p>}
				{state.side?.turns.map((turn, i) => <div key={i}><article className="rb-message rb-user you"><div className="rb-message-heading you-label">□ You · side ask</div><Markdown text={turn.question} /></article>{turn.answer && <article className="rb-message rb-stop"><div className="rb-message-heading">Answer · model-derived</div><Markdown text={turn.answer} /><Copy text={turn.answer} /></article>}{turn.error && <p className="rb-error" role="alert">No answer ({turn.error}). Ask again or End to discard the snapshot.</p>}</div>)}
				{state.pending && <><article className="rb-message rb-user you"><div className="rb-message-heading you-label">□ You · side ask</div><Markdown text={state.pending} /></article><p className="rb-state" role="status">Reading the Rarebits…</p></>}
			</section>}
		</div>
		<footer className="rb-footer">
			<div className="rb-toolbar">{hasSide && <span className="rb-meta">Temporary side thread</span>}<button className="btn ghost small" onClick={() => { pinned.current = false; setTailSpace(0); if (!hasSide) set({ window: filtered.length }); requestAnimationFrame(() => scroller.current?.scrollTo({ top: 0 })); }}>↑ Top</button><button className="btn ghost small" title="Previous user message" aria-label="Previous user message" disabled={hasSide || steps.prev === undefined || steps.prev < 0} onClick={() => step(steps.prev)}>Prev</button><button className="btn ghost small" title="Next user message" aria-label="Next user message" disabled={hasSide || steps.next === undefined || steps.next < 0} onClick={() => step(steps.next)}>Next</button><button className="btn ghost small" onClick={() => { pinned.current = true; setTailSpace(0); set({ window: 60 }); requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight })); }}>↓ Bottom</button></div>
			<form className="rb-ask" onSubmit={(e) => { e.preventDefault(); void ask(); }}><textarea ref={input} className="quiet-scroll" data-scrollbar="none" aria-label={state.side ? "Follow up on the side" : "Ask on the side"} placeholder={state.side ? "Follow up…" : "Ask on the side (Rarebits only)…"} rows={2} maxLength={20_000} value={state.draft} onChange={(e) => set({ draft: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (freshPress(e.nativeEvent)) void ask(); } }} /><button className="btn" type="submit" disabled={!state.draft.trim() || Boolean(state.pending) || !count}>Ask</button></form>
		</footer>
	</div>;
}
