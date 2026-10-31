import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { SearchHit } from "../../../src/pi/search.ts";
import type { PiThreadView, ThreadOutline } from "../../../src/shared/protocol.ts";
import { hub } from "../client.ts";
import { findSteps, navigate } from "../nav.ts";
import { plural } from "../plural.ts";
import { centerInList, href } from "../util.ts";
import { FindSession } from "./find-session.ts";
import { FormRow } from "./FormRow.tsx";

/** Typing settles this long before Find scans the Session: one scan per settled query, never one per keystroke. */
const SETTLE_MS = 300;

/**
 * Find in the open Session: one FindSession per Session, read through React. `reading` names the entry at the reader's
 * place, where a result opens. `thread` is the Session's thread topic: each frame of it with a `sourceVersion` announces
 * the Host's index to a request that waits for it. One Find session per open bar: its first match jump is a history
 * step, later ones replace it (D20).
 */
export function useSessionFind(host: string, threadId: string, reading: () => string | undefined, thread: PiThreadView | undefined) {
	const step = useRef(findSteps());
	const readingRef = useRef(reading);
	readingRef.current = reading;
	const session = useMemo(() => new FindSession({
		find: (query, ask) => hub.request(host, "thread.find", { threadId, query, ...ask }),
		reading: () => readingRef.current(),
		reveal: (hit) => navigate(href.thread(host, threadId, { entry: hit.entry }), step.current()),
		settleMs: SETTLE_MS,
	}), [host, threadId]);
	useEffect(() => () => session.dispose(), [session]);
	useEffect(() => { if (thread?.sourceVersion) session.indexed(); }, [session, thread]);
	const view = useSyncExternalStore(session.subscribe, session.get);
	return {
		...view,
		show: () => session.show(),
		close: () => { session.close(); step.current = findSteps(); },
		setQuery: (query: string) => session.setQuery(query),
		toggleTools: () => session.setTools(!view.tools),
		toggleFilter: () => session.setFilter(!view.filter),
		pick: (k: number) => session.pick(k),
		step: (by: 1 | -1) => session.step(by),
		earlier: () => session.earlier(),
		endFilter: () => session.setFilter(false),
	};
}
export type SessionFind = ReturnType<typeof useSessionFind>;

/** The Find bar: a band above the transcript, never over it. On a narrow row its controls wrap below the query. */
export function FindBar({ find, onClose }: { find: SessionFind; onClose: () => void }) {
	const count = find.busy ? "…" : find.indexing ? "Indexing…" : find.error ? "Failed" : !find.query.trim() ? "" : !find.matches.length ? "No results" : find.at === undefined ? `${find.total} ${plural(find.total, "match", "matches")}` : `${find.skipped + find.at + 1} / ${find.total}`;
	return <FormRow className="find-bar" role="search" aria-label="Find in this Session" field={<input autoFocus aria-label="Find in Session" placeholder="Find in Session" value={find.query} maxLength={500} onChange={(e) => find.setQuery(e.target.value)} />} onKeyDown={(e) => {
		if (e.key === "Escape") { e.preventDefault(); onClose(); }
		else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); find.step(e.shiftKey ? -1 : 1); }
		else if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyT") { e.preventDefault(); find.toggleTools(); }
		else if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyM") { e.preventDefault(); find.toggleFilter(); }
	}}>
		<span className="c" role="status" title={find.error ?? (find.scanned ? `${find.scanned} ${plural(find.scanned, "entry", "entries")} scanned` : undefined)}>{count}</span>
		{find.wrapped && <span className="find-wrap hint">{find.wrapped === "top" ? "Wrapped to top" : "Wrapped to bottom"}</span>}
		<button className="ib" title="Previous match (⇧↵)" aria-label="Previous match" disabled={!find.matches.length} onClick={() => find.step(-1)}>▲</button>
		<button className="ib" title="Next match (↵)" aria-label="Next match" disabled={!find.matches.length} onClick={() => find.step(1)}>▼</button>
		<button className={`chip${find.tools ? " on" : ""}`} aria-pressed={find.tools} title="Also search tool calls, results and thinking (⌥T)" onClick={find.toggleTools}>{find.tools ? "✓ " : "+ "}Tools</button>
		<button className={`chip${find.filter ? " on" : ""}`} aria-pressed={find.filter} title="Show only matching entries (⌥M)" onClick={find.toggleFilter}>{find.filter ? "✓ " : ""}Filter</button>
		<button className="ib" title="Close (Esc)" aria-label="Close Find" onClick={onClose}>×</button>
	</FormRow>;
}

/** Marks every case-insensitive occurrence of `q` in `text`. */
export function marked(text: string, q: string): ReactNode[] {
	const lower = text.toLowerCase(), needle = q.toLowerCase(), out: ReactNode[] = [];
	if (!needle) return [text];
	let from = 0;
	for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) {
		out.push(text.slice(from, i), <mark key={i}>{text.slice(i, i + needle.length)}</mark>);
		from = i + needle.length;
	}
	out.push(text.slice(from));
	return out;
}

const KIND: Record<string, string> = { human: "You", assistant: "Agent", compaction: "Summary", tool: "Tool" };

/**
 * Filter to matches: only the matching entries, each under its prompt, with dashed rows for the hidden entries. A
 * click on a match or a dashed row shows the full transcript at that match.
 */
export function FindFiltered({ find, outline }: { find: SessionFind; outline?: ThreadOutline }) {
	const list = useRef<HTMLDivElement>(null);
	const prompts = useMemo(() => new Map(outline?.users.map((u, i) => [u.id, { n: i + 1, text: u.firstLine }]) ?? []), [outline]);
	useEffect(() => { const cur = list.current?.querySelector<HTMLElement>(".find-hit.cur"); if (cur) centerInList(list.current!, cur); }, [find.at, find.matches]);
	const q = find.query.trim();
	const rows: ReactNode[] = [];
	let prev: SearchHit | undefined;
	find.matches.forEach((hit, i) => {
		const gap = prev ? (hit.at ?? 0) - (prev.at ?? 0) - 1 : (hit.at ?? 0);
		// Matches before the window are not shown; the row asks for them.
		if (!prev && find.skipped) rows.push(<button key="earlier" className="find-gap" title="Show earlier matches" onClick={find.earlier}>⋯ {find.skipped} earlier {plural(find.skipped, "match", "matches")}</button>);
		else if (gap > 0) rows.push(<button key={`gap-${hit.entry}`} className="find-gap" title="Show the full transcript here" onClick={() => find.pick(i)}>⋯ {gap} {plural(gap, "entry", "entries")} hidden</button>);
		if (hit.prompt && hit.prompt !== hit.entry && hit.prompt !== prev?.prompt) {
			const p = prompts.get(hit.prompt);
			rows.push(<div key={`p-${hit.entry}`} className="find-prompt"><span className="lbl">You</span>{p && <span className="hint">#{p.n}</span>} <span className="tx">{p?.text || "Prompt"}</span></div>);
		}
		rows.push(<button key={hit.entry} data-find-hit={hit.entry} className={`find-hit${i === find.at ? " cur" : ""}`} onClick={() => find.pick(i)} title="Show in the full transcript">
			<span className="k">{KIND[hit.kind ?? ""] ?? hit.kind}</span><span className="x">{marked(hit.snippet, q)}</span>
		</button>);
		prev = hit;
	});
	return <div className="scroll find-filtered quiet-scroll" ref={list} data-region="transcript" tabIndex={-1} aria-label="Matching entries">
		{find.busy ? <div className="empty">Finding…</div> : find.indexing ? <div className="empty">Indexing this Session…</div> : !q ? <div className="empty">Type to find in this Session.</div> : !find.matches.length ? <div className="empty">{find.error ?? "No matching entries."}</div> : rows}
		{find.more && <div className="hint find-more">More matches than shown · narrow the query</div>}
	</div>;
}

/** Highlights `q` in the rendered transcript through CSS Custom Highlights; prose scope skips tool and thinking text. */
export function useFindHighlight(root: RefObject<HTMLElement | null>, q: string, tools: boolean, current: string | undefined) {
	useEffect(() => {
		const el = root.current;
		const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
		const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
		if (!el || !registry || !H) return;
		const needle = q.trim().toLowerCase();
		let frame = 0;
		const paint = () => {
			frame = 0;
			const all: Range[] = [], cur: Range[] = [];
			if (needle) {
				const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
				for (let node = walk.nextNode(); node; node = walk.nextNode()) {
					const parent = node.parentElement;
					if (!parent || (!tools && parent.closest(".tool, .thinking"))) continue;
					const text = node.nodeValue!.toLowerCase();
					const inCur = current && parent.closest(`[data-entry="${CSS.escape(current)}"]`);
					for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
						const r = new Range(); r.setStart(node, i); r.setEnd(node, i + needle.length);
						(inCur ? cur : all).push(r);
					}
				}
			}
			registry.set("ampi-find", new H(...all));
			registry.set("ampi-find-cur", new H(...cur));
		};
		const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
		const observer = new MutationObserver(schedule);
		observer.observe(el, { childList: true, subtree: true, characterData: true });
		schedule();
		return () => { observer.disconnect(); cancelAnimationFrame(frame); registry.delete("ampi-find"); registry.delete("ampi-find-cur"); };
	}, [root, q, tools, current]);
}
