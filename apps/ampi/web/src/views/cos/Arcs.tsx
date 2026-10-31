import { useState } from "react";
import type { ArcChunk, ArcHead, ArcListValue, ArcValue } from "../../../../src/pi/views/cos-arc.ts";
import { NEEDS_YOU_KINDS } from "../../../../src/pi/views/cos-arc-context.ts";
import { CHUNK_RULE } from "../../../../src/pi/views/cos-arc-rules.ts";
import { isSessionInScope } from "../../../../src/shared/session-scope.ts";
import { useHosts, useTopic } from "../../client.ts";
import { hostLabelFor } from "../../components/host-label.ts";
import { AvailableModels, useArcBuild, type ArcBuild } from "./ArcPanel.tsx";
import { href, type Route } from "../../util.ts";
import { ArcContextView } from "./ArcTree.tsx";
import { GLYPHS, glyphTitle } from "./glyphs.ts";
import { dateTime, FeedStatus, useFleet, type ViewError } from "./data.tsx";
import { buildDetail, buildText, estimateText, failureHint, failurePrefix, failureText, labelRetry, lastFailure, progressText, stuckText } from "./builds.ts";
import "./cos.css";

export function Arcs({ route }: { route: Route }) {
	const [host, threadId] = route.rest;
	return host && threadId ? <Arc key={`${host}/${threadId}`} host={host} threadId={threadId} /> : <ArcList />;
}

/** The Host's Arc list: the `cos.arc` topic without a Session. */
function useArcList(host: string) {
	const feed = useTopic(host, { kind: "view", view: "cos.arc" });
	const value = feed.value;
	return { ...feed, value: value && ("sessions" in value || "error" in value) ? value : undefined };
}

function ArcList() {
	const { feeds, readers, connected } = useFleet<ArcListValue>(useArcList);
	const rows = feeds.flatMap((f) => (f.value?.sessions ?? []).filter((s) => isSessionInScope({ activityAt: s.end, live: s.live })).map((s) => ({ ...s, host: f.host.link }))).sort((a, b) => b.end - a.end);
	const [limit, setLimit] = useState(100);
	return <main className="main cos-page">{readers}
		<header className="cos-header"><h1>Arcs</h1><span className="cos-meta">{rows.length} long-running Sessions</span><a href={href.page("timeline")}>Timeline</a></header>
		<p className="cos-caption">Sessions active within 96 hours, plus live Sessions. Recover the shape of a long Session. Chunks are deterministic. Project labels and the context tree build when you ask, and automatically after an agent stop in a running Session.</p>
		<FeedStatus feeds={feeds} connected={connected} />
		<div className="cos-scroll quiet-scroll cos-list">
			<div className="cos-list-head cos-arc-list-head"><span>Session</span><span>Context</span><span>Span</span><span>Entries</span><span>Explore</span></div>
			{rows.slice(0, limit).map((s) => <div className="cos-list-row cos-arc-list-row" key={s.ref}>
				<div className="cos-session-name"><a href={href.page("arcs", [s.host, s.threadId])} title={s.title}>{s.title}</a><span>{s.host} · {dateTime(s.start)} → {dateTime(s.end)}</span></div>
				<HeadCell head={s.head} />
				<span>{((s.end - s.start) / 3600_000).toFixed(1)} h</span><span>{s.entryCount.toLocaleString()}</span>
				<div className="cos-links"><a href={href.thread(s.host, s.threadId)}>Session</a><a href={href.page("timeline", [], { focus: s.ref })}>Timeline</a></div>
			</div>)}
			{rows.length > limit && <button className="btn ghost" onClick={() => setLimit(limit + 100)}>Show 100 more Sessions</button>}
			{!rows.length && <p className="cos-empty">{feeds.some((f) => !f.value && !f.error) ? "Reading the Sessions…" : "No long Sessions yet. Sessions with 200 entries or a 20-hour span appear here. Any Session’s topbar can open its Arc."}</p>}
		</div>
	</main>;
}

/** The Arcs list reads only the receipt head: availability, open asks per kind, and staleness. */
function HeadCell({ head }: { head: ArcHead }) {
	if (!head.built) return <span className="cos-meta">Not built</span>;
	const open = NEEDS_YOU_KINDS.filter((k) => head.open[k]).map((k) => `${head.open[k]} ${k}`);
	return <span className="cos-arc-head">{open.length ? <strong className="cos-wait-label">Needs you · {open.join(" · ")}</strong> : <span className="cos-meta">No open asks</span>}{head.overtaken > 0 && <span className="cos-meta">{head.overtaken} overtaken</span>}<span className="cos-meta">{head.newMessages ? `${head.newMessages} new since build` : head.branchChanged ? "branch changed" : "current"}</span></span>;
}

function Arc({ host, threadId }: { host: string; threadId: string }) {
	const { value, stale, error } = useTopic(host, { kind: "view", view: "cos.arc", threadId });
	// With a Session the topic never publishes the list.
	const page = value && "sessions" in value ? undefined : value;
	return <ArcPageView host={host} label={hostLabelFor(host, useHosts().hosts)} threadId={threadId} value={page} stale={stale} error={error} build={useArcBuild(host, threadId)} />;
}

/** Pure view of one Arc page, so tests render it without a hub connection. */
export function ArcPageView({ host, label, threadId, value, stale, error, build }: { host: string; /** The Host label; the route key can be a link key such as `devbox#pi`. */ label?: string; threadId: string; value?: ArcValue | { missing: true; notice: string } | ViewError; stale: boolean; error?: string; build: ArcBuild }) {
	const [limit, setLimit] = useState(100);
	const { pending, failure } = build;
	const v = value && !("missing" in value) && !("error" in value) ? value : undefined;
	const viewError = value && "error" in value ? value.error.message : error;
	const failed = v ? lastFailure(v) : null;
	return <main className="main cos-page">
		<header className="cos-header cos-arc-header"><h1 title={v?.title}>Arc{v ? ` · ${v.title}` : ""}</h1><nav className="cos-links"><a href={href.page("arcs")}>All arcs</a><a href={href.thread(host, threadId)}>Session</a><a href={href.page("timeline", [], { focus: `${host}/${threadId}` })}>Timeline</a></nav></header>
		{!v ? <p className="cos-empty" role="status">{viewError ? `${viewError}. Reconnect the Host, then open this Arc again.` : value && "notice" in value ? value.notice : "Reading the Session and chunking its active branch…"}</p> : <>
			<div className="cos-toolbar"><span>{label ?? hostLabelFor(host, [])} · {v.chunks.length} chunks · {v.coverage.labelledChunks} labelled{v.coverage.unmappedChunks ? ` · ${v.coverage.unmappedChunks} to label` : ""}</span><span className="spacer" /><button className="btn" disabled={!v.chunks.length || pending || v.job?.state === "running"} onClick={build.start}>{pending || v.job?.state === "running" ? "Building arc…" : "Build arc"}</button></div>
			<p className="cos-caption" title="Input estimate uses characters ÷ 4, including prompt overhead and estimated synthesis labels. Evidence targets 7,000 characters per chunk; owner lines are shortened last. Output tokens and dollar pricing depend on the hub’s model.">Build estimate: {estimateText(v.buildEstimate)}{v.buildEstimate.truncatedChunks ? ` · ${v.buildEstimate.truncatedChunks} chunk evidence windows shortened` : ""}{v.coverage.excludedEntries ? ` · ${v.coverage.excludedEntries} imported / inherited entries excluded` : ""}.</p>
			{v.builds?.length > 0 && <details className="cos-builds"><summary className="cos-meta">Builds · last: {buildText(v.builds.at(-1)!)} · {dateTime(v.builds.at(-1)!.startedAt)}</summary><p className="cos-meta">An agent stop in a running Session updates the Arc automatically when new messages exist, at most once every 10 minutes.</p><ul>{v.builds.toReversed().map((b) => <li key={b.startedAt} className="cos-meta" title={buildDetail(b)}>{dateTime(b.startedAt)} · {buildText(b)}{b.afterEntryId && <> · after <a href={href.thread(host, threadId, { entry: b.afterEntryId })}>[#{b.afterEntryId}]</a></>}</li>)}</ul></details>}
			<p className="cos-notice">{v.notice}</p>
			{v.source && v.source.state !== "ready" && <p className="cos-notice">Last indexed evidence · {dateTime(v.source.asOf)} · {v.source.state}</p>}
			{viewError && <p className="cos-error" role="alert">{viewError}. Reconnect, then reopen this Arc to refresh its cached evidence.</p>}
			{stale && <p className="cos-notice" role="status">Connection unavailable; this is cached evidence. Builds need the hub, and use its local copy rather than newer Host entries.</p>}
			{failure ? <p className="cos-error" role="alert">{failurePrefix(undefined)} {failure} Deterministic chunks remain below. {failureHint(undefined)}</p>
				: failed && <><p className="cos-error" role={failed.role}>{failureText(failed.failure, v.keptAt, labelRetry(failed.failure, v))}{v.keptAt ? "" : " Deterministic chunks remain below."}</p><AvailableModels failure={failed.failure} /></>}
			{v.job?.state === "running" && <p className="cos-notice" role="status">{progressText(v.job)}</p>}
			{stuckText(v) && <p className="cos-notice" role="status">{stuckText(v)}</p>}
			<div className="cos-scroll quiet-scroll cos-arc-body">
				<ArcContextView value={v} />
				{v.synthesis && <p className="cos-headline">{v.synthesis.headline}<span className="cos-meta">{v.synthesis.model ? ` · ${v.synthesis.model}` : ""}{v.synthesis.builtAt ? ` · built ${dateTime(v.synthesis.builtAt)}` : ""}{v.coverage.synthesisCurrent ? " · current" : ""}</span></p>}
				<section aria-label="Projects"><h2>Projects <span className="cos-meta">inferred</span></h2>{!v.cards.length ? <p className="cos-meta">No project labels yet. The chunks below are available without a model.</p> : v.cards.map((card, i) => <div className="cos-project" key={card.name}><span className={`cos-project-mark cos-color-${i % 6}`} /><div><a href={href.thread(host, threadId, { entry: card.resumeEntryId })}>{card.name}</a><span className="cos-meta"> · {card.chunks} chunks{card.inferred ? ` · ${card.inferred.status}` : ""}</span>{card.inferred && <p title={card.inferred.full?.summary}>{card.inferred.summary}</p>}</div></div>)}</section>
				{v.transitions.length > 0 && <details aria-label="Transitions"><summary>Transitions <span className="cos-meta">{v.transitions.length} inferred · expand to inspect</span></summary>{v.transitions.map((t, i) => { const chunk = v.chunks[Number(t.chunk.slice(1))]; return <div className="cos-transition" key={i}><time>{dateTime(chunk?.startAt ?? null)}</time><div>{t.from} → {t.to}<span className="cos-meta"> · {t.kind.replace(/_/g, " ")} · {t.source}</span>{t.why && <p>{t.why}</p>}{chunk && <a href={href.thread(host, threadId, { entry: chunk.firstEntryId })}>Open transition’s entry</a>}</div></div>; })}</details>}
				<section aria-label="Chunks over time"><h2>Chunks over time</h2><p className="cos-meta">{CHUNK_RULE} Start and end times open the first and last message.</p><p className="cos-meta cos-chunk-legend">A line marks where the label state changes: {CHUNK_STATES.map((k) => <span key={k} className="cos-chunk-key" data-state={k}>{CHUNK_STATE_TEXT[k]}</span>)}</p>
				{v.chunks.slice(0, limit).map((chunk, i, shown) => <ChunkRow key={chunk.id} host={host} threadId={threadId} chunk={chunk} index={i} previous={shown[i - 1]} />)}
				{v.chunks.length > limit && <button className="btn ghost" onClick={() => setLimit(limit + 100)}>Show 100 more chunks</button>}
				{!v.chunks.length && <p className="cos-empty">No chunks yet. This Session’s active branch has no entries.</p>}</section>
			</div>
		</>}
	</main>;
}

const CHUNK_STATES = ["labelled", "stale", "unlabelled", "relabel"] as const;
const CHUNK_STATE_TEXT = { labelled: "labelled", stale: "stale label", unlabelled: "unlabelled", relabel: "unlabelled · relabel pending" } as const;
const chunkState = (c: ArcChunk) => (c.labelCurrent ? "labelled" : c.label ? "stale" : c.relabel ? "relabel" : "unlabelled");

function Count({ kind, n }: { kind: keyof typeof GLYPHS; n: number }) {
	return <span className="cos-glyph" title={glyphTitle(kind, n)}><span aria-hidden="true">{GLYPHS[kind].glyph}</span> {n}<span className="cos-sr"> {n === 1 ? GLYPHS[kind].one : GLYPHS[kind].many}</span></span>;
}

/** One chunk: start, end and project in fixed columns; a coloured line where the label state changes. */
function ChunkRow({ host, threadId, chunk, index, previous }: { host: string; threadId: string; chunk: ArcChunk; index: number; previous?: ArcChunk }) {
	const state = chunkState(chunk);
	return <>
		{previous && chunkState(previous) !== state && <div className="cos-chunk-divider" data-state={state} role="separator" aria-label={`${CHUNK_STATE_TEXT[state]} chunks from here`}><span aria-hidden="true">{CHUNK_STATE_TEXT[state]} from here</span></div>}
		<article className="cos-chunk" data-state={state}>
			<a className="cos-chunk-start" title="Open the chunk’s first message" href={href.thread(host, threadId, { entry: chunk.firstEntryId })}><time>{dateTime(chunk.startAt)}</time></a>
			<a className="cos-chunk-end" title="Open the chunk’s last message" href={href.thread(host, threadId, { entry: chunk.lastEntryId })}><time>{dateTime(chunk.endAt)}</time></a>
			<span className="cos-chunk-project" title={chunk.label?.project}>{chunk.label ? chunk.label.project : "unlabelled"}{state === "stale" && <span className="cos-meta"> · stale label</span>}</span>
			<div className="cos-chunk-content"><div className="cos-links"><a title="Open first message" href={href.thread(host, threadId, { entry: chunk.firstEntryId })}><span title={chunk.label?.full?.topic}>{chunk.label?.topic ?? `Chunk ${index + 1}`}</span></a></div><p>{chunk.firstAsk ?? "Compaction or continuation; open the evidence."}</p><div className="cos-links cos-meta"><Count kind="ownerTurns" n={chunk.ownerTurns} /><Count kind="toolCalls" n={chunk.toolCalls} /><a href={href.page("timeline", [], { focus: `${host}/${threadId}`, ...(chunk.startAt ? { at: String(Date.parse(chunk.startAt)) } : {}) })}>Timeline</a></div></div>
		</article>
	</>;
}
