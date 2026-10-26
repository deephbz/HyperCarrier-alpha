// The tier-2 tree, rendered identically by the Arc page and the Session view's Arc panel. Pure: no hub client, so
// tests can render it without a connection.

import type { ArcValue } from "../../../../src/pi/views/cos-arc.ts";
import { NEEDS_YOU_KINDS, type ArcContext, type Citation, type ContextLeaf, type ContextThread } from "../../../../src/pi/views/cos-arc-context.ts";
import { ago, href } from "../../util.ts";

const FOLD_AFTER = 15;
const when = (t: string) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** A citation names its Session by ref; href.ref turns it into the typed route of its Host source (Pi or durable). */
function cite(c: Citation, label = `#${c.entryId}`) {
	return <a key={`${c.session}#${c.entryId}`} href={href.ref(`${c.session}#${c.entryId}`)} title={`${c.session} · entry ${c.entryId}`}>[{label}]</a>;
}

/** One line: the short title, an ask's kind badge, citations and age. The longer text and the cited quote show on expand. */
function leafItem(leaf: ContextLeaf, i: number) {
	const asked = leaf.citations[0]?.at;
	// Receipts built before `closed` mark an answered ask only by its answer citation.
	const closed = leaf.ask ? leaf.closed ?? (leaf.resolvedBy.length ? "answered" : undefined) : undefined;
	const by = leaf.resolvedBy.length ? leaf.resolvedBy.map((c) => cite(c)) : "a later owner turn";
	const line = <>
		<span className="cos-leaf-title">{leaf.text}</span>
		{leaf.ask && leaf.kind ? <> <span className="badge cos-badge">{leaf.kind}</span></> : null} {leaf.citations.map((c) => cite(c))}
		{leaf.ask && closed !== "answered" && asked ? <span className="cos-meta"> · asked {ago(asked)} ago</span> : null}
		{closed === "answered" && <span className="cos-meta"> · closed → answered {by}</span>}
		{closed === "overtaken" && <span className="cos-meta"> · overtaken by {by}</span>}
	</>;
	const quote = leaf.quote && normalized(leaf.quote) !== normalized(leaf.full ?? leaf.text) ? leaf.quote : "";
	return <li key={`${leaf.text}-${i}`} className={closed ? "cos-context-closed" : undefined}>
		{leaf.full || quote ? <details className="cos-leaf"><summary title={quote ? `“${quote}”` : leaf.full}>{line}</summary>
			{leaf.full && <p>{leaf.full}</p>}
			{quote && <blockquote>{leaf.ask ? "Asked: " : ""}“{quote}”</blockquote>}
		</details> : line}
	</li>;
}
const normalized = (s: string) => s.replace(/[\s*_`]+/g, " ").trim().toLowerCase();

function contextBranch(label: string, leaves: ContextLeaf[], empty: string) {
	// An empty branch stays visible as one quiet line, so absence reads as "none cited", never as missing data.
	if (!leaves.length) return <p className="cos-meta cos-context-empty">{label}: {empty}</p>;
	return <div className="cos-context-branch"><h3>{label}</h3><ul>{leaves.map(leafItem)}</ul></div>;
}

/**
 * Tier 2: Needs you first and never folded, then its folded Overtaken asks; threads fold after about fifteen leaves;
 * Unassigned always shows.
 */
function ContextTree({ context }: { context: ArcContext }) {
	const asks = context.needsYou.length, overtaken = context.overtaken ?? [];
	const count = (t: ContextThread) => t.progress.length + t.decisions.length + t.blockers.length;
	let shown = 0;
	const visible = context.threads.filter((t, i) => { const keep = i === 0 || shown + count(t) <= FOLD_AFTER; if (keep) shown += count(t); return keep; });
	const folded = context.threads.slice(visible.length);
	const thread = (t: ContextThread) => <section className="cos-context-thread" key={t.label}><h3 title={t.full}>{t.label} <span className="badge cos-badge">{t.state}</span></h3>{contextBranch("Progress", t.progress, "none cited.")}{contextBranch("Decisions", t.decisions, "none cited.")}{contextBranch("Blockers", t.blockers, "none cited.")}</section>;
	const unassigned = <section className="cos-context-thread"><h3>Unassigned</h3>{contextBranch("Progress", context.unassigned.progress, "none cited.")}{contextBranch("Decisions", context.unassigned.decisions, "none cited.")}{contextBranch("Blockers", context.unassigned.blockers, "none cited.")}</section>;
	const sessions = [...new Set(context.needsYou.flatMap((l) => l.citations.map((c) => c.session)))];
	return <section aria-label="Evergreen context">
		<h2>Needs you <span className="cos-meta">{asks}{overtaken.length ? ` · ${overtaken.length} overtaken` : ""}</span></h2>
		{!asks ? <p className="cos-meta">{context.coverage.evidenceEntries ? `No open asks in ${context.coverage.evidenceEntries} Rarebit messages.` : "No Rarebit evidence in this build."}</p> : NEEDS_YOU_KINDS.filter((k) => context.needsYou.some((l) => l.kind === k)).map((k) => <div key={k}>{contextBranch(`${k[0]!.toUpperCase()}${k.slice(1)}`, context.needsYou.filter((l) => l.kind === k), "")}</div>)}
		{overtaken.length > 0 && <details className="cos-context-overtaken"><summary>Overtaken asks <span className="cos-meta">{overtaken.length} · a later owner turn moved on without answering</span></summary><ul>{overtaken.map(leafItem)}</ul></details>}
		<h2>Work tree <span className="cos-meta">{context.threads.length} threads</span></h2>
		{!context.threads.length && <p className="cos-meta">No threads cited; see Unassigned.</p>}
		{visible.map(thread)}
		{folded.length > 0 && <details><summary>{folded.length} more threads <span className="cos-meta">folded after {FOLD_AFTER} leaves</span></summary>{folded.map(thread)}</details>}
		{unassigned}
		{(context.answered?.length ?? 0) > 0 && <details className="cos-context-answered"><summary>Answered asks <span className="cos-meta">{context.answered!.length}</span></summary><ul>{context.answered!.map(leafItem)}</ul></details>}
		<p className="cos-meta">Evidence: {context.coverage.citedEntries}/{context.coverage.evidenceEntries} Rarebit messages cited · {context.coverage.omittedEntries} omitted · as of {context.asOfEntryId ? `#${context.asOfEntryId}` : "no entry"} · built {when(context.builtAt)}{context.model ? ` · ${context.model}` : ""}{sessions.length ? ` · ${sessions.join(", ")}` : ""}</p>
	</section>;
}

type TreeValue = Pick<ArcValue, "context" | "contextStatus"> & Partial<Pick<ArcValue, "nextAutoAt" | "relabelChunks" | "floor" | "queuedAhead" | "backoff" | "stuck" | "autoOff">>;
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A Pi Team Bright Worker Session builds only on Build arc. */
const WORKER_LINE = "Worker Session: Arcs update only when you click Build arc.";

/**
 * The stale line: what the tree covers, what is newer, and when it updates. One rule (Rarebit messages) for the tree
 * and the synthesis; a pending automatic Build replaces the Build arc prompt with its due time. A queued Build says how
 * many run first; a failure backoff says why the update waits, unless the stuck line already says it. A Worker Session
 * names its manual-only rule instead.
 */
function coverText({ context, contextStatus: s, nextAutoAt, queuedAhead, backoff, stuck, autoOff }: TreeValue) {
	const next = autoOff === "worker" ? WORKER_LINE
		: queuedAhead ? `Waiting for ${queuedAhead} automatic Build${queuedAhead === 1 ? "" : "s"} ahead · Build arc starts now.`
		: backoff && !stuck && nextAutoAt ? `After ${backoff.failures} failure${backoff.failures === 1 ? "" : "s"}, next try ${clock(nextAutoAt)}.`
		: nextAutoAt ? `Next automatic update ≈${clock(nextAutoAt)}.` : "";
	if (s.branchChanged) return `The active Rarebit branch changed since this Build. ${next || "Build arc to cover it."}`;
	const upTo = s.coveredAt ? when(new Date(s.coveredAt).toISOString()) : context?.asOfEntryId ? `#${context.asOfEntryId}` : "its start";
	return `Covered up to ${upTo} · ${s.newMessages} newer message${s.newMessages === 1 ? "" : "s"}. ${next || "Build arc to cover them."}`;
}

/**
 * The stale line, then Needs you and the folded Work tree; a missing receipt says Not built. Below the floor a quiet
 * line comes first; it replaces Not built, and a stored tree with work threads stays below it.
 */
export function ArcContextView({ value: v }: { value: TreeValue }) {
	return <>
		{v.floor && <p className="cos-meta" role="status">Nothing to summarize yet. {v.autoOff === "worker" ? WORKER_LINE : `Arcs build automatically after ${v.floor.min} messages; this Session has ${v.floor.messages}.`}</p>}
		{(v.contextStatus.newMessages > 0 || v.contextStatus.branchChanged) && <p className="cos-notice" role="status">{coverText(v)}</p>}
		{v.relabelChunks ? <p className="cos-notice" role="status">Chunk rules changed; one Build relabels {v.relabelChunks} chunk{v.relabelChunks === 1 ? "" : "s"}.{v.nextAutoAt ? ` Next automatic update ≈${clock(v.nextAutoAt)}.` : ""}</p>
			: v.context && v.contextStatus.formatChanged && <p className="cos-notice">This Arc uses an older Arc format. The next Build rewrites it.</p>}
		{v.context ? <ContextTree context={v.context} /> : !v.floor && <section aria-label="Evergreen context"><h2>Needs you</h2><p className="cos-meta">{v.contextStatus.unknown ? "This Arc was built before the work tree existed, so what it covers is unknown. Build arc to create the cited work tree." : "Not built. Build arc to create the cited work tree from this Session’s Rarebit messages."}</p></section>}
	</>;
}
