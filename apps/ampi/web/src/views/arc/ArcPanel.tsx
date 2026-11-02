// The Session's Arc receipt view. Read and disclosure never start a Build (docs/arc.md).
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { hoverIntent } from "../../components/Popover.tsx";
import type { ThreadSummary } from "../../../../src/shared/protocol.ts";
import { hub, useTopic } from "../../client.ts";
import { centerInList, clock, money, tokens } from "../../util.ts";
import { Citations, type ReadMessage } from "./Citations.tsx";
import { ChapterTimeline } from "./Timeline.tsx";
import type { ArcValue, ArcWork, Bullet, Claim, Point } from "../../../../src/shared/protocol.ts";
import "./arc.css";
import { ReceiptPlace } from "./ReceiptPlace.tsx";

export type ArcBuild = { pending: boolean; failure?: string; start: (rebuild?: boolean) => void };
const time = (at: string) => clock(Date.parse(at));
const STATES = { request: ["open", "in progress", "blocked", "done", "dropped"], decision: ["confirm", "accepted", "reversed"], rule: ["in force", "lifted"], confusion: ["open", "resolved"] };
const KINDS = { request: "Requests", decision: "Decisions", rule: "Rules", confusion: "Confusions" };
type Evidence = { host: string; threadId: string; readMessage?: ReadMessage };
function ClaimText({ claim, ...evidence }: { claim: Claim } & Evidence) {
	return <>{claim.text}<Citations cites={claim.cites} {...evidence} /></>;
}
function Bullets({ bullets, ...evidence }: { bullets: Bullet[] } & Evidence) {
	return <ul>{bullets.map((b, i) => <li key={i}><ClaimText claim={b} {...evidence} />{b.children?.length ? <Bullets bullets={b.children} {...evidence} /> : null}</li>)}</ul>;
}
// Elapsed time ticks here, outside the status region, so a screen reader does not announce it every second.
function Elapsed({ since }: { since: string }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
	const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
	return <span className="arc-elapsed">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>;
}
// Build progress is an annotation: the whole job in one muted line, and the reason for a retry on hover.
function Progress({ work }: { work: ArcWork }) {
	const n = (v: number) => v.toLocaleString();
	return <p className="arc-progress"><span role="status" title={work.reason ? `Last answer rejected: ${work.reason}` : undefined}>Building messages {n(work.from)}–{n(work.to)} · part {work.part} of {Math.max(work.part, work.parts)}{work.attempt > 1 ? ` · try ${work.attempt} of ${work.attempts}` : ""}</span> · <Elapsed since={work.startedAt} /></p>;
}
// A kept item keeps its previous version because a recent Build could not update it.
const Kept = ({ kept }: { kept?: boolean }) => kept ? <p className="arc-kept">May be out of date: a recent Build could not update this.</p> : null;
function PointItem({ point: p, chapter = false, kept, ...evidence }: { point: Point; chapter?: boolean; kept?: boolean } & Evidence) {
	return <article className="arc-point" data-point={p.id}>
		<strong>{chapter && <span className="arc-meta">{p.chapter} · </span>}{p.title}</strong><span className="arc-point-state">{p.needsYou ? p.state === "confirm" ? "Confirm or reverse" : p.state === "blocked" ? "Unblock" : "Answer" : p.state}</span>
		<div>{p.text}<Citations cites={p.cites} {...evidence} /></div>
		<Kept kept={kept} />
	</article>;
}

export function ArcPanelView({ host, threadId, value, error, disconnected, summary, build, readMessage }: Evidence & {
	value?: ArcValue; error?: string; disconnected?: boolean; summary?: ThreadSummary; build: ArcBuild;
}) {
	const receipt = value?.receipt;
	const [arrival, setArrival] = useState({ stamp: receipt?.builtAt, updated: false });
	if (arrival.stamp !== receipt?.builtAt) setArrival({ stamp: receipt?.builtAt, updated: Boolean(arrival.stamp) });
	const [unit, setUnit] = useState<1 | 2>(1);
	const [opened, setOpened] = useState<Set<number>>(() => new Set());
	const [hover, setHover] = useState<number>();
	const [flash, setFlash] = useState<{ n: number; key: number }>();
	const [kind, setKind] = useState<Point["kind"]>("request");
	const [scope, setScope] = useState<number | "all">("all");
	const rows = useRef(new Map<number, HTMLButtonElement>());
	const boards = useRef<HTMLElement>(null);
	const evidence = { host, threadId, readMessage };
	const current = receipt?.chapters.at(-1);
	const busy = build.pending || value?.status.state === "building";
	const lastError = receipt?.builds.at(-1)?.error;
	const failure = build.failure || error || (value?.status.error?.code !== "busy" ? value?.status.error?.message : undefined) || (value?.status.state === "idle" && lastError?.code !== "busy" ? lastError?.message : undefined);
	const remaining = receipt && value?.sourceCount !== undefined && !value.branchChanged ? Math.max(0, value.sourceCount - receipt.asOfCount) : 0;
	const partial = remaining > 0;
	const savedPartial = partial && receipt?.builds.at(-1)?.state === "failed";
	const points = receipt?.points.filter((p) => scope === "all" || p.chapter === scope) ?? [];
	const selected = points.filter((p) => p.kind === kind);
	const needs = receipt?.points.filter((p) => p.needsYou).sort((a, b) => {
		const rank = (p: Point) => p.state === "blocked" ? 0 : p.state === "confirm" ? 1 : 2;
		return rank(a) - rank(b) || Date.parse(a.firstAt) - Date.parse(b.firstAt);
	}) ?? [];
	const reveal = (target?: HTMLElement | null) => { const scroller = target?.closest<HTMLElement>(".panel-body"); if (target && scroller) centerInList(scroller, target); };
	const openBand = (n: number) => {
		setOpened((old) => new Set([...old, n]));
		reveal(rows.current.get(n));
	};
	const toggle = (n: number) => {
		setOpened((old) => { const next = new Set(old); if (next.has(n)) next.delete(n); else next.add(n); return next; });
		setFlash((old) => ({ n, key: (old?.key ?? 0) + 1 }));
	};
	return <ReceiptPlace stamp={receipt?.builtAt}>
		<header className="arc-status">
			<span className="arc-meta">Arc{receipt ? <> · {savedPartial ? "Saved" : arrival.updated ? "Updated" : "built"} {time(receipt.builtAt)}{savedPartial && " (partial)"} · {partial ? <span className="arc-nowrap">Covers {receipt.asOfCount.toLocaleString()} of {value!.sourceCount!.toLocaleString()} messages</span> : <>covers to {current ? time(current.lastAt) : receipt.asOf.slice(0, 6)} · {value!.stale} newer message{value!.stale === 1 ? "" : "s"}</>}</> : " · not built"}</span>
			<div className="arc-actions"><button className="btn small" disabled={busy} onClick={() => build.start()}>{busy ? "Building…" : "Build"}</button>
			<details className="arc-menu"><summary aria-label="Arc Build options">⋯</summary><button className="btn small" disabled={busy} onClick={(e) => { e.currentTarget.closest("details")!.open = false; build.start(true); }}>Rebuild</button></details></div>
		</header>
		{disconnected && <p className="arc-meta" role="status">Disconnected. Showing the cached Arc; reconnect to refresh it.</p>}
		{value?.branchChanged && <p className="arc-meta" role="status">The Session branch or selection changed. Rebuild to cover it.</p>}
		{/* Old receipts can end with a busy Build record; current Builds write none. */}
		{value?.status.state === "idle" && lastError?.code === "busy" && <p className="arc-meta" role="status">Waiting for a model slot. Build to retry.</p>}
		{value?.status.state === "building" && value.status.work && <Progress work={value.status.work} />}
		{value && value.status.state !== "idle" && value.status.state !== "failed" && !(value.status.state === "queued" && failure) && !(value.status.state === "building" && value.status.work) && <p className="arc-meta" role="status">{value.status.progress || (value.status.state === "building" ? "Building Arc…" : value.status.state === "queued" ? "Queued" : "Build failed")}{value.status.nextAt ? ` · starts ${time(value.status.nextAt)}` : ""}</p>}
		{failure && <div className="arc-error" role="alert">{failure.length > 180 ? <details><summary>Build failed: {failure.slice(0, 180)}…</summary>{failure}</details> : <>Build failed: {failure}</>}{value?.status.nextAt && ` · next try ${time(value.status.nextAt)}`}{receipt ? " · Showing the last good Arc." : ""} {partial ? "Build to cover the remaining messages." : "Retry Build."}</div>}
		{!receipt ? <p className="arc-meta">{value ? "Build an Arc to see the goal, chapters and key points from this Session." : "Reading the saved Arc…"}</p> : <>
			<h2>Now{current && <span> · chapter {current.n}</span>}</h2>
			<section className="arc-now" aria-label="Now" data-arc-place="now">
				{current && <strong className="arc-now-label">{current.label}</strong>}
				<p className="arc-meta">{summary ? summary.activity !== "idle" ? "The agent is working." : summary.live ? value?.lastStopAt ? "The agent is idle." : `The agent is idle · last activity ${time(new Date(summary.updatedAt).toISOString())}.` : "No live agent is reported." : "Live Session state unavailable."}{value?.lastStopAt && ` Its last report was ${time(value.lastStopAt)}.`}</p>
				<p><ClaimText claim={receipt.now} {...evidence} /></p>
				<Kept kept={receipt.kept?.includes("now")} />
				{needs.length ? <div className="arc-needs"><h3>Needs you <span>({needs.length})</span></h3>{needs.map((p) => <PointItem key={p.id} point={p} kept={receipt.kept?.includes(p.id)} {...evidence} />)}</div> : <p className="arc-hint">Nothing waits for you.</p>}
				<div className="arc-goal"><b>Goal.</b> <ClaimText claim={receipt.goal} {...evidence} /><Kept kept={receipt.kept?.includes("goal")} /></div>
			</section>
			<section aria-label="Chapters">
				<div className="arc-section-head"><h2>Chapters <span>({receipt.chapters.length})</span></h2><div className="seg" aria-label="Timeline unit">{([1, 2] as const).map((u) => <button key={u} className={unit === u ? "on" : ""} aria-pressed={unit === u} onClick={() => setUnit(u)}>{u === 1 ? "Tokens" : "$"}</button>)}</div><button className="btn ghost small" onClick={() => setOpened(new Set(receipt.chapters.map((c) => c.n)))}>Expand all</button><button className="btn ghost small" onClick={() => setOpened(new Set())}>Collapse all</button></div>
				<ChapterTimeline chapters={receipt.chapters} series={value?.series} unit={unit} hover={hover} flash={flash} onHover={setHover} onOpen={openBand} />
				<div className="arc-chapters">{[...receipt.chapters].reverse().map((c) => <div key={c.n} className={`arc-chapter ${hover === c.n ? "hover" : ""}`} data-chapter={c.n} data-arc-place={`chapter-${c.n}`} {...hoverIntent(() => setHover(c.n))} onMouseLeave={() => setHover(undefined)}>
					<button className="arc-chapter-row" ref={(node) => { if (node) rows.current.set(c.n, node); else rows.current.delete(c.n); }} aria-expanded={opened.has(c.n)} aria-controls={`chapter-${c.n}`} onClick={() => toggle(c.n)} onFocus={() => setHover(c.n)} onBlur={() => setHover(undefined)}>
						<span className="arc-n">{c.n}</span><span className="arc-label">{opened.has(c.n) ? "▾" : "▸"} {c.label}</span>
						<span className="arc-span" title={`${new Date(c.firstAt).toLocaleString()} → ${new Date(c.lastAt).toLocaleString()}`}>{time(c.firstAt)} → {time(c.lastAt)}</span><span className="arc-tokens">{tokens(c.tokens)}</span><span className="arc-cost">{money(c.cost)}</span>
					</button>
					{opened.has(c.n) && <div className="arc-chapter-summary" id={`chapter-${c.n}`}><p><ClaimText claim={c.summary.scope} {...evidence} /></p><Bullets bullets={c.summary.bullets} {...evidence} />{receipt.points.some((p) => p.chapter === c.n) && <button className="btn ghost small" onClick={() => { setScope(c.n); const first = receipt.points.find((p) => p.chapter === c.n); if (first) setKind(first.kind); reveal(boards.current); }}>Show its {receipt.points.filter((p) => p.chapter === c.n).length} key points</button>}</div>}
				</div>)}</div>
			</section>
			<section ref={boards} className="arc-key-points" aria-label="Key points" data-arc-place="points">
				<div className="arc-section-head"><h2>Key points <span>({points.length})</span></h2><label className="arc-meta">Scope <select aria-label="Key point scope" value={scope} onChange={(e) => setScope(e.target.value === "all" ? "all" : Number(e.target.value))}><option value="all">All chapters</option>{receipt.chapters.map((c) => <option key={c.n} value={c.n}>Chapter {c.n}</option>)}</select></label></div>
				<div className="arc-kind-tabs seg" aria-label="Key point kind">{(Object.keys(KINDS) as Point["kind"][]).map((k) => <button key={k} className={kind === k ? "on" : ""} aria-pressed={kind === k} onClick={() => setKind(k)}>{KINDS[k]} ({points.filter((p) => p.kind === k).length})</button>)}</div>
				<div className="arc-board" style={{ "--arc-columns": STATES[kind].length } as CSSProperties}>{STATES[kind].map((state) => { const items = selected.filter((p) => p.state === state); return <section className="arc-column" key={state} aria-label={state}><h3>{state} ({items.length})</h3>{items.length ? items.map((p) => <PointItem key={p.id} point={p} kept={receipt.kept?.includes(p.id)} chapter={scope === "all"} {...evidence} />) : <p className="arc-meta">None</p>}</section>; })}</div>
			</section>
			{receipt.builds.length > 0 && <details className="arc-builds"><summary>Build record · {receipt.model}</summary>{[...receipt.builds].reverse().map((b, i) => <p key={i}>{time(b.endedAt)} · {b.trigger} · {b.state} · {b.calls} calls{b.newChapters && ` · new chapters ${b.newChapters.join(", ")}`} · {b.usage.cost === null ? "cost unavailable" : money(b.usage.cost)}{b.error && ` · ${b.error.message}`}{b.repairs.length > 0 && ` · repairs: ${b.repairs.join("; ")}`}</p>)}</details>}
		</>}
	</ReceiptPlace>;
}

export function ArcPanel({ host, threadId, summary }: { host: string; threadId: string; summary?: ThreadSummary }) {
	const feed = useTopic(host, { kind: "view", view: "arc", threadId });
	const [pending, setPending] = useState(false), [failure, setFailure] = useState<string>();
	const start = async (rebuild = false) => {
		setPending(true); setFailure(undefined);
		try { await hub.request(host, "view.arc.build", { threadId, ...(rebuild ? { rebuild: true } : {}) }); }
		catch (e) { setFailure((e as Error).message); }
		finally { setPending(false); }
	};
	const value = feed.value && "status" in feed.value ? feed.value : undefined;
	return <ArcPanelView host={host} threadId={threadId} summary={summary} value={value} error={feed.value && "error" in feed.value ? feed.value.error.message : feed.error} disconnected={feed.stale && Boolean(value)} build={{ pending, failure, start: (rebuild) => void start(rebuild) }} />;
}
