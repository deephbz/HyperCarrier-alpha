// The Session's Arc receipt view. Read and disclosure never start a Build (docs/arc.md).
import { Component, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { hoverIntent } from "../../components/Popover.tsx";
import type { ThreadSummary } from "../../../../src/shared/protocol.ts";
import { hub, useTopic } from "../../client.ts";
import { newId } from "../../ids.ts";
import { centerInList, clock, money, tokens } from "../../util.ts";
import { Citations, type ReadMessage } from "./Citations.tsx";
import { ChapterTimeline } from "./Timeline.tsx";
import type { ArcValue, ArcWork, Bullet, Claim, Point } from "../../../../src/shared/protocol.ts";
import "./arc.css";
import { ReceiptPlace } from "./ReceiptPlace.tsx";
import { BuildState, DropLines, failureText, requestText, ServiceLines, type DismissFailure } from "./ArcStatus.tsx";
import type { ArcRequest } from "../../../../src/shared/arc.ts";

export type ArcBuild = { pending: boolean; failure?: string; dismissFailure?: DismissFailure; outcome?: ArcRequest; dismissing?: { id: string; toPosition: number }[]; start: (rebuild?: boolean) => void; dismiss?: (dropId: string, toPosition: number) => void };
const time = (at: string | null) => at !== null && Number.isFinite(Date.parse(at)) ? clock(Date.parse(at)) : "time unavailable";
const fullTime = (at: string | null) => at !== null && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString() : "time unavailable";
const STATES = { request: ["open", "in progress", "blocked", "done", "dropped"], decision: ["confirm", "accepted", "reversed"], rule: ["in force", "lifted"], confusion: ["open", "resolved"] };
const KINDS = { request: "Requests", decision: "Decisions", rule: "Rules", confusion: "Confusions" };
type Evidence = { host: string; threadId: string; readMessage?: ReadMessage };
function ClaimText({ claim, ...evidence }: { claim: Claim } & Evidence) {
	return <>{claim.text}<Citations cites={claim.cites} {...evidence} /></>;
}
function Bullets({ bullets, ...evidence }: { bullets: Bullet[] } & Evidence) {
	return <ul>{bullets.map((b, i) => <li key={i}><ClaimText claim={b} {...evidence} />{b.children?.length ? <Bullets bullets={b.children} {...evidence} /> : null}</li>)}</ul>;
}
// Build progress is an annotation: the whole job in one muted line, and the reason for a retry on hover.
function Progress({ work }: { work: ArcWork }) {
	const n = (v: number) => v.toLocaleString();
	return <p className="arc-progress"><span role="status" title={work.reason ? `Last answer rejected: ${work.reason}` : undefined}>Building messages {n(work.from)}–{n(work.to)} · part {work.part} of {Math.max(work.part, work.parts)}{work.attempt > 1 ? ` · try ${work.attempt} of ${work.attempts}` : ""}</span></p>;
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
	const busy = build.pending || value?.status.state === "building" || value?.status.state === "waiting";
	const cannotBuild = disconnected || value?.services?.some(service => service.host === host && ["stopped", "fault", "busy", "error", "cannot-start", "unreachable", "updating", "stopping"].includes(service.state));
	const stale = disconnected || Boolean(value?.statusStale);
	const unavailable = value?.services?.some((service) => service.host === host && service.state === "unreachable");
	const request = value?.request?.requestId === build.outcome?.requestId && value?.request?.outcome === "accepted" ? value.request : build.outcome ?? value?.request;
	const requestLine = build.pending ? undefined : requestText(request, host, value?.services?.find(service => service.host === host));
	const lastError = receipt?.builds.at(-1)?.error;
	const statusError = value?.status.record?.error ?? value?.status.error ?? (value?.status.state === "idle" ? lastError : undefined);
	const failure = Boolean(build.failure || error || statusError);
	const lostNeeds = receipt?.drops?.filter((drop) => drop.needsYou).length ?? 0;
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
			<span className="arc-meta">Arc{receipt ? <> · {savedPartial ? "Saved" : arrival.updated ? "Updated" : "built"} {time(receipt.builtAt)}{savedPartial && " (partial)"} · {partial ? <span className="arc-nowrap">Covers {receipt.asOfCount.toLocaleString()} of {value!.sourceCount!.toLocaleString()} messages</span> : <>covers to {current ? time(current.lastAt) : receipt.asOf.slice(0, 6)}{!stale && !unavailable && <> · {value!.stale} newer message{value!.stale === 1 ? "" : "s"}</>}</>}</> : " · not built"}</span>
			<div className="arc-actions"><button className="btn small" disabled={busy || cannotBuild} onClick={() => build.start()}>{build.pending ? "Build requested" : value?.status.state === "waiting" ? "Waiting" : busy ? "Building…" : "Build"}</button>
			<details className="arc-menu"><summary aria-label="Arc Build options">⋯</summary><button className="btn small" disabled={busy || cannotBuild} onClick={(e) => { e.currentTarget.closest("details")!.open = false; build.start(true); }}>Rebuild</button></details></div>
		</header>
		{disconnected && <p className="arc-meta" role="status">Disconnected from the hub. Status as of {value?.status.observedAt ? time(value.status.observedAt) : "last update"}.</p>}
		<ServiceLines services={value?.services} />
		{!receipt && value?.v2Removed && <p className="arc-meta">Arcs from the previous version were removed. Build to create this Session's Arc.</p>}
		{requestLine && <p className="arc-meta" role="status">{requestLine}</p>}
		{requestLine && request?.outcome === "refused" && request.detail && <details className="arc-meta"><summary>Request details</summary><p>{request.detail}</p></details>}
		{value?.branchChanged && <p className="arc-meta" role="status">The Session branch or selection changed. Rebuild to cover it.</p>}
		{value?.status.state === "building" && value.status.work && <Progress work={value.status.work} />}
		{value && value.status.state !== "idle" && value.status.state !== "failed" && value.status.state !== "waiting" && value.status.state !== "uncertain" && !(value.status.state === "queued" && failure) && !(value.status.state === "building" && value.status.work) && <p className="arc-meta" role="status">{value.status.progress || (value.status.state === "building" ? "Building Arc…" : value.status.state === "queued" ? "Queued" : "Build failed")}{value.status.nextAt ? ` · starts ${time(value.status.nextAt)}` : ""}</p>}
		{failure && <div className="arc-error" role="alert">{build.failure || error ? "Build request failed." : failureText(statusError, host)}{value?.status.nextAt && ` Next try ${time(value.status.nextAt)}.`}{receipt ? " Showing the last good Arc." : ""} {partial ? "Build to cover the remaining messages." : "Retry Build."}{(build.failure || error) && <details><summary>Request details</summary><p>{build.failure || error}</p></details>}</div>}
		{value && <BuildState value={value} stale={stale} host={host} />}
		{!receipt ? <p className="arc-meta">{value ? "Build an Arc to see the goal, chapters and key points from this Session." : "Reading the saved Arc…"}</p> : <>
			<h2>Now{current && <span> · chapter {current.n}</span>}</h2>
			<section className="arc-now" aria-label="Now" data-arc-place="now">
				{current && <strong className="arc-now-label">{current.label}</strong>}
				<p className="arc-meta">{summary ? summary.activity !== "idle" ? "The agent is working." : summary.live ? value?.lastStopAt ? "The agent is idle." : `The agent is idle · last activity ${time(new Date(summary.updatedAt).toISOString())}.` : "No live agent is reported." : "Live Session state unavailable."}{value?.lastStopAt && ` Its last report was ${time(value.lastStopAt)}.`}</p>
				<p><ClaimText claim={receipt.now} {...evidence} /></p>
				<Kept kept={receipt.kept?.includes("now")} />
				{needs.length || receipt.drops?.some((drop) => drop.needsYou) ? <div className="arc-needs"><h3>Needs you <span>({needs.length}{lostNeeds > 0 && ` · ${lostNeeds} not added`})</span></h3>{needs.map((p) => <PointItem key={p.id} point={p} kept={receipt.kept?.includes(p.id)} {...evidence} />)}{value && <DropLines value={value} host={host} threadId={threadId} dismiss={build.dismiss} dismissing={build.dismissing} dismissFailure={build.dismissFailure} needsYou />}</div> : <p className="arc-hint">Nothing waits for you.</p>}
				<div className="arc-goal"><b>Goal.</b> <ClaimText claim={receipt.goal} {...evidence} /><Kept kept={receipt.kept?.includes("goal")} /></div>
			</section>
			<section aria-label="Chapters">
				<div className="arc-section-head"><h2>Chapters <span>({receipt.chapters.length})</span></h2><div className="seg" aria-label="Timeline unit">{([1, 2] as const).map((u) => <button key={u} className={unit === u ? "on" : ""} aria-pressed={unit === u} onClick={() => setUnit(u)}>{u === 1 ? "Tokens" : "$"}</button>)}</div><button className="btn ghost small" onClick={() => setOpened(new Set(receipt.chapters.map((c) => c.n)))}>Expand all</button><button className="btn ghost small" onClick={() => setOpened(new Set())}>Collapse all</button></div>
				<ChapterTimeline chapters={receipt.chapters} series={value?.series} unit={unit} hover={hover} flash={flash} onHover={setHover} onOpen={openBand} />
				<div className="arc-chapters">{[...receipt.chapters].reverse().map((c) => <div key={c.n} className={`arc-chapter ${hover === c.n ? "hover" : ""}`} data-chapter={c.n} data-arc-place={`chapter-${c.n}`} {...hoverIntent(() => setHover(c.n))} onMouseLeave={() => setHover(undefined)}>
					<button className="arc-chapter-row" ref={(node) => { if (node) rows.current.set(c.n, node); else rows.current.delete(c.n); }} aria-expanded={opened.has(c.n)} aria-controls={`chapter-${c.n}`} onClick={() => toggle(c.n)} onFocus={() => setHover(c.n)} onBlur={() => setHover(undefined)}>
						<span className="arc-n">{c.n}</span><span className="arc-label">{opened.has(c.n) ? "▾" : "▸"} {c.label}</span>
						<span className="arc-span" title={`${fullTime(c.firstAt)} → ${fullTime(c.lastAt)}`}>{time(c.firstAt)} → {time(c.lastAt)}</span><span className="arc-tokens">{tokens(c.tokens)}</span><span className="arc-cost">{money(c.cost)}</span>
					</button>
					{opened.has(c.n) && <div className="arc-chapter-summary" id={`chapter-${c.n}`}><p><ClaimText claim={c.summary.scope} {...evidence} /></p><Bullets bullets={c.summary.bullets} {...evidence} />{receipt.points.some((p) => p.chapter === c.n) && <button className="btn ghost small" onClick={() => { setScope(c.n); const first = receipt.points.find((p) => p.chapter === c.n); if (first) setKind(first.kind); reveal(boards.current); }}>Show its {receipt.points.filter((p) => p.chapter === c.n).length} key points</button>}</div>}
				</div>)}</div>
			</section>
			<section ref={boards} className="arc-key-points" aria-label="Key points" data-arc-place="points">
				<div className="arc-section-head"><h2>Key points <span>({points.length})</span></h2><label className="arc-meta">Scope <select aria-label="Key point scope" value={scope} onChange={(e) => setScope(e.target.value === "all" ? "all" : Number(e.target.value))}><option value="all">All chapters</option>{receipt.chapters.map((c) => <option key={c.n} value={c.n}>Chapter {c.n}</option>)}</select></label></div>
				{value && <DropLines value={value} host={host} threadId={threadId} dismiss={build.dismiss} dismissing={build.dismissing} dismissFailure={build.dismissFailure} needsYou={false} />}
				<div className="arc-kind-tabs seg" aria-label="Key point kind">{(Object.keys(KINDS) as Point["kind"][]).map((k) => <button key={k} className={kind === k ? "on" : ""} aria-pressed={kind === k} onClick={() => setKind(k)}>{KINDS[k]} ({points.filter((p) => p.kind === k).length})</button>)}</div>
				<div className="arc-board" style={{ "--arc-columns": STATES[kind].length } as CSSProperties}>{STATES[kind].map((state) => { const items = selected.filter((p) => p.state === state); return <section className="arc-column" key={state} aria-label={state}><h3>{state} ({items.length})</h3>{items.length ? items.map((p) => <PointItem key={p.id} point={p} kept={receipt.kept?.includes(p.id)} chapter={scope === "all"} {...evidence} />) : <p className="arc-meta">None</p>}</section>; })}</div>
			</section>
			{receipt.builds.length > 0 && <details className="arc-builds"><summary>Build record · {receipt.model}</summary>{[...receipt.builds].reverse().map((b, i) => <p key={i}>{time(b.endedAt)} · {b.trigger}{b.requester && ` from ${b.requester}`}{value?.builderHost && ` · built on ${value.builderHost}`} · {b.state} · {b.calls} calls{b.newChapters && ` · new chapters ${b.newChapters.join(", ")}`} · {b.usage.cost === null ? "cost unavailable" : money(b.usage.cost)}{b.possibleRepeatCost && " · may have been charged; this Build may repeat the cost"}{b.error && ` · ${b.error.message}`}{b.repairs.length > 0 && ` · repairs: ${b.repairs.join("; ")}`}</p>)}</details>}
		</>}
	</ReceiptPlace>;
}

class ArcPanelBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
 state: { error: Error | null } = { error: null };
 static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) }; }
 render() {
  if (!this.state.error) return this.props.children;
  return <div className="arc-error" role="alert">
   <p>Arc could not be displayed. Retry the view or use another panel.</p>
   <button className="btn small" onClick={() => this.setState({ error: null })}>Retry view</button>
   <details><summary>Error details</summary><p>{this.state.error.message}</p></details>
  </div>;
 }
}

type ArcPanelProps = { host: string; threadId: string; summary?: ThreadSummary };
export function ArcPanel(props: ArcPanelProps) {
 return <ArcPanelBoundary key={`${props.host}|${props.threadId}`}><ConnectedArcPanel {...props} /></ArcPanelBoundary>;
}

function ConnectedArcPanel({ host, threadId, summary }: ArcPanelProps) {
	const feed = useTopic(host, { kind: "view", view: "arc", threadId });
	const value = feed.value && "status" in feed.value ? feed.value : undefined;
	const [pending, setPending] = useState(false), [failure, setFailure] = useState<string>();
	const [outcome, setOutcome] = useState<ArcRequest>();
	const active = useRef<{ requestId: string; accepted: boolean } | undefined>(undefined);
	if (value?.request?.outcome === "accepted" && active.current?.requestId === value.request.requestId) active.current.accepted = true;
	useEffect(() => {
		if (value?.request?.outcome === "accepted" || value?.request?.outcome === "refused") setOutcome((local) => local?.requestId === value.request?.requestId ? undefined : local);
	}, [value?.request]);
	const [dismissFailure, setDismissFailure] = useState<DismissFailure>();
	const [dismissing, setDismissing] = useState<{ id: string; toPosition: number }[]>([]);
	useEffect(() => {
		active.current = undefined; setPending(false); setOutcome(undefined); setFailure(undefined); setDismissFailure(undefined); setDismissing([]);
	}, [host, threadId]);
	useEffect(() => {
		setDismissing((pending) => {
			const remaining = pending.filter((d) => value?.receipt?.drops?.some((drop) => drop.id === d.id && drop.toPosition === d.toPosition));
			return remaining.length === pending.length ? pending : remaining;
		});
	}, [value?.receipt]);
	const start = async (rebuild = false) => {
		const requestId = newId();
		active.current = { requestId, accepted: false };
		setPending(true); setFailure(undefined); setOutcome(undefined);
		try {
			const result = await hub.request(host, "view.arc.build", { threadId, requestId, ...(rebuild ? { rebuild: true } : {}) });
			if (active.current?.requestId !== requestId) return;
			if ("outcome" in result && !(result.outcome === "unknown" && active.current.accepted)) setOutcome({ ...result, requestId });
		}
		catch (e) { if (active.current?.requestId === requestId) setFailure((e as Error).message); }
		finally { if (active.current?.requestId === requestId) setPending(false); }
	};
	const dismiss = async (dropId: string, toPosition: number) => {
		setDismissFailure(undefined); setDismissing((pending) => [...pending, { id: dropId, toPosition }]);
		try {
			const result = await hub.request(host, "view.arc.dismiss", { threadId, dropId, toPosition });
			if (result.outcome !== "refused") return;
		} catch {}
		setDismissing((pending) => pending.filter((d) => d.id !== dropId || d.toPosition !== toPosition));
		setDismissFailure({ id: dropId, toPosition, message: "The warning could not be dismissed. Try again." });
	};
	return <ArcPanelView host={host} threadId={threadId} summary={summary} value={value} error={feed.value && "error" in feed.value ? feed.value.error.message : feed.error} disconnected={feed.stale && Boolean(value)} build={{ pending, failure, dismissFailure, dismissing, outcome, start: (rebuild) => void start(rebuild), dismiss: (dropId, toPosition) => void dismiss(dropId, toPosition) }} />;
}
