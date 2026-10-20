import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { TimelineSession, TimelineValue } from "../../../../src/pi/views/cos-timeline.ts";
import { isSessionInScope, SESSION_SCOPE_MS } from "../../../../src/shared/session-scope.ts";
import { navigate } from "../../nav.ts";
import { href, money, tokens, type Route } from "../../util.ts";
import { dateTime, FeedStatus, useFleet } from "./data.tsx";
import { seenAt } from "../../seen.ts";
import { RangeBrush } from "./RangeBrush.tsx";
import type { TimeRange } from "./range.ts";
import { nextTimelineWindow, timelineWindow, windowRange } from "./window.ts";
import { inPanel, type PanelSelection } from "./panel.ts";
import { drawnSpan, laneTotal, mergeBuckets, type Unit } from "./totals.ts";
import { SessionTitle } from "../../components/SessionTitle.tsx";
import { useTopic } from "../../client.ts";
import { isPiThreadId, type ThreadsState } from "../../../../src/shared/protocol.ts";
import "./cos.css";
import { hub } from "../../client.ts";

type Session = TimelineSession & { host: string };
type Band = { key: string; title: string; members: Session[]; target: Session; team: boolean; buckets: [number, number, number][]; start: number; end: number };
const ROW = 56;
const X = 1000;

export function nearest(entries: [number, string][], t: number): string | undefined {
	let lo = 0, hi = entries.length;
	while (lo < hi) { const mid = (lo + hi) >>> 1; if (entries[mid]![0] < t) lo = mid + 1; else hi = mid; }
	const a = entries[lo - 1], b = entries[lo];
	return !a ? b?.[1] : !b || t - a[0] <= b[0] - t ? a[1] : b[1];
}

/**
 * "needs you": the same evidence the sidebar's ! uses here — a blocked pane, or a Session whose latest mark is a
 * terminal error. "new": an idle agent's answer that arrived after the owner last opened the Session. Seen times are
 * read once per page visit, so rows do not reorder under the pointer after a visit.
 */
type Attention = "needs" | "new" | undefined;
const rank = (band: Band, seen: Map<string, number>) => Math.max(0, ...band.members.map((s) => ({ needs: 2, new: 1 })[attention(s, seen) ?? "x" as never] ?? 0));
function attention(s: Session, seen: Map<string, number>): Attention {
	const last = s.marks.reduce<Session["marks"][number] | undefined>((a, m) => (!a || m[0] >= a[0] ? m : a), undefined);
	if (s.blocked || last?.[2] === "error") return "needs";
	if (!seen.has(s.ref)) seen.set(s.ref, seenAt(s.ref));
	if (s.waiting && last?.[2] === "stop" && last[0] > seen.get(s.ref)!) return "new";
	return undefined;
}

function group(sessions: Session[], merged: boolean): Band[] {
	const groups = new Map<string, Session[]>();
	const leads = new Set(sessions.filter((s) => s.team && s.role === "lead").map((s) => `${s.host}/${s.team}`));
	for (const s of sessions) {
		const team = `${s.host}/${s.team}`;
		const key = merged && s.team && leads.has(team) ? `team:${team}` : s.ref;
		const members = groups.get(key) ?? []; members.push(s); groups.set(key, members);
	}
	return [...groups].map(([key, members]) => {
		const team = key.startsWith("team:");
		const target = (team ? members.find((s) => s.role === "lead") : members[0])!;
		return { key, title: target.title, target, team, members,
			buckets: mergeBuckets(members), start: Math.min(...members.map((s) => s.start)), end: Math.max(...members.map((s) => s.end)) };
	});
}

function LaneTitle({ session, title, team }: { session: Session; title: string; team: boolean }) {
	// useTopic shares the Host's existing thread index subscription with the sidebar and other lanes.
	const { value } = useTopic(session.host, { kind: "threads" });
	return <SessionTitle title={title} summary={isPiThreadId(session.threadId) ? value?.threads[session.threadId] : undefined} host={session.host}>
		<a href={href.thread(session.host, session.threadId, { panel: team ? "team" : "rarebit" })}>{title}</a>
	</SessionTitle>;
}

const amount = (unit: Unit, n: number) => unit === 2 ? money(n) : tokens(Math.round(n));

const Stream = memo(function Stream({ band, from, to, bucketMs, unit, scale, color, focus, now, moment, onHover, seen, total }: {
	seen: Map<string, number>;
	band: Band; from: number; to: number; bucketMs: number; unit: Unit; scale: number; color: number; focus: boolean; total: number;
	now: number; moment?: number;
	onHover: (text: string) => void;
}) {
	const [at, setAt] = useState((from + to) / 2);
	useEffect(() => setAt((from + to) / 2), [from, to]);
	const x = (t: number) => (t - from) / (to - from) * X;
	const top: string[] = [];
	for (const b of band.buckets) {
		const span = drawnSpan(b, band, bucketMs), start = Math.max(from, span[0]), end = Math.min(to, span[1]);
		if (end <= start || !b[unit]) continue;
		const h = b[unit] * scale;
		// Separate subpaths preserve genuinely empty buckets instead of inventing spend across gaps.
		top.push(`M${x(start)},${28 - h}H${x(end)}V${28 + h}H${x(start)}Z`);
	}
	const entry = nearest(band.target.entries, at);
	const link = href.thread(band.target.host, band.target.threadId, { entry, panel: band.team ? "team" : "rarebit" });
	const needing = band.members.filter((s) => attention(s, seen) === "needs");
	const fresh = band.members.filter((s) => attention(s, seen) === "new");
	const flagged = needing[0] ?? fresh[0];
	const waiting = Boolean(flagged);
	const report = (t: number) => {
		setAt(t);
		const bucket = Math.floor(t / bucketMs) * bucketMs;
		const b = band.buckets.find((b) => b[0] === bucket);
		onHover(`${band.title} · ${dateTime(t)} · ${unit === 2 ? money(b?.[2] ?? 0) : `${tokens(b?.[1] ?? 0)} tokens`} / 15 min${band.team ? ` · opens the lead’s Team panel${needing.length ? ` · needs you: ${needing.map((s) => s.title).join(", ")}` : fresh.length ? ` · new answer: ${fresh.map((s) => s.title).join(", ")}` : ""}` : " · opens nearest entry"}`);
	};
	return <div className={`cos-stream-row ${focus ? "cos-focused" : ""} ${needing.length ? "cos-waiting" : ""}`} style={{ height: ROW }}>
		<div className="cos-band-label"><LaneTitle session={band.target} title={band.title} team={band.team} /><span>{[
			<span className="cos-total" title={`${band.team ? "Team" : "Session"} total in range: ${unit === 2 ? `$${total.toFixed(4)}` : `${Math.round(total).toLocaleString()} tokens`}`}>{amount(unit, total)}</span>,
			band.members.some((s) => s.source && s.source.state !== "ready") && "last indexed copy",
			band.members.some((s) => s.live) && <span className="cos-live">live</span>,
			flagged && <a className={needing.length ? "cos-wait-label" : "cos-new-label"} href={href.thread(flagged.host, flagged.threadId, { panel: "rarebit" })} title={`Open ${flagged.title} with its Rarebit panel`} aria-label={`${needing.length ? "Needs you" : "New answer"}: ${flagged.title}`}>{needing.length ? "needs you" : "new answer"}</a>,
			<a href={href.page("arcs", [band.target.host, band.target.threadId])}>Arc</a>,
		].filter(Boolean).map((part, i) => <Fragment key={i}>{i ? " · " : ""}{part}</Fragment>)}</span></div>
		<svg viewBox={`0 0 ${X} 56`} preserveAspectRatio="none" aria-label={`${band.title}, spend over time`}>
			{band.end >= from && band.start <= to && <line x1={Math.max(0, x(band.start))} x2={Math.min(X, x(band.end))} y1="28" y2="28" className="cos-duration" />}
			{now >= from && now <= to && <line x1={x(now)} x2={x(now)} y1="0" y2="56" className="cos-now" />}
			{moment !== undefined && moment >= from && moment <= to && <rect x={x(moment) - 2} y="0" width="4" height="56" className="cos-moment" />}
			<a href={link} aria-label={`Open ${band.title} at nearest entry`} onClick={(e) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); void hub.request(band.target.host, "view.cos.timeline.locate", { threadId: band.target.threadId, at }).then((r) => { navigate(href.thread(band.target.host, band.target.threadId, { entry: r.entry, panel: band.team ? "team" : "rarebit" })); }, (error) => onHover(String(error))); }} onFocus={() => report(at)} onMouseMove={(e) => { const box = e.currentTarget.closest("svg")!.getBoundingClientRect(); report(from + (e.clientX - box.left) / box.width * (to - from)); }}>
				<path className={`cos-band cos-color-${color}`} d={top.join("")} />
				<rect x={Math.max(0, x(band.start))} y="4" width={Math.max(0, Math.min(X, x(Math.max(band.end, band.start + 60_000))) - Math.max(0, x(band.start)))} height="48" fill="transparent" />
			</a>
		</svg>
	</div>;
});

export function Timeline({ route }: { route: Route }) {
	return <TimelineView route={route} />;
}

export function TimelinePanel({ host, threadId, summary }: { host: string; threadId: string; summary?: { team?: { teamId: string } } }) {
	const route: Route = { page: "timeline", rest: [], query: new URLSearchParams({ focus: `${host}/${threadId}`, all: "1" }) };
	return <TimelineView route={route} selected={{ host, threadId, teamId: summary?.team?.teamId }} />;
}

/** One Host's timeline replica, for `useFleet`. */
const useTimeline = (host: string) => useTopic(host, { kind: "view", view: "cos.timeline" });

function TimelineView({ route, selected }: { route: Route; selected?: PanelSelection }) {
	// Seen times as of this visit: labels and order stay put while the page is open.
	const seen = useMemo(() => new Map<string, number>(), []);
	const { feeds, readers, connected } = useFleet<TimelineValue>(useTimeline);
	const [hover, setHover] = useState("Hover a stream to inspect its bucket. Click to open the nearest entry.");
	const [scroll, setScroll] = useState(0);
	const [preview, setPreview] = useState<TimeRange>();
	const [panelQuery, setPanelQuery] = useState(route.query);
	const queryParams = selected ? panelQuery : route.query;
	const routeQuery = queryParams.toString();
	useEffect(() => setPreview(undefined), [routeQuery]);
	const [now, setNow] = useState(Date.now());
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
	const unit = queryParams.get("unit") === "dollars" ? 2 : 1;
	const merged = queryParams.get("teams") !== "separate";
	const sessions = useMemo(() => feeds.flatMap((f) => (f.value?.sessions ?? []).filter((s) => {
		// The panel keeps only its Session and Team; open Sessions are always in scope.
		if (selected) return s.entries.length > 0 && inPanel({ ...s, host: f.host.id }, selected);
		return s.entries.length > 0 && isSessionInScope({ activityAt: s.end, live: s.live, open: false });
	} ).map((s) => ({ ...s, host: f.host.id, live: connected && !f.stale && f.host.status === "connected" && s.live }))), [feeds, connected, selected]);
	const focus = queryParams.get("focus");
	const focused = sessions.find((s) => s.ref === focus);
	const min = Math.min(...sessions.map((s) => s.start)), max = Math.max(...sessions.map((s) => s.end));
	const fullFrom = selected
		? Number.isFinite(min) ? Math.min(min - 60_000, now - 60_000) : now - SESSION_SCOPE_MS
		: now - SESSION_SCOPE_MS;
	const fullTo = selected && Number.isFinite(max) ? Math.max(max + 60_000, now) : now;
	const at = Number(queryParams.get("at"));
	const moment = queryParams.has("at") && Number.isFinite(at) ? at : undefined;
	const requestedFrom = Number(queryParams.get("from")), requestedTo = Number(queryParams.get("to"));
	const validRange = queryParams.has("from") && queryParams.has("to") && Number.isFinite(requestedFrom) && Number.isFinite(requestedTo) && requestedTo > requestedFrom;
	const from = preview?.[0] ?? (validRange ? Math.max(fullFrom, Math.min(requestedFrom, fullTo - 60_000)) : selected ? (queryParams.has("all") ? fullFrom : Math.max(fullFrom, now - SESSION_SCOPE_MS)) : moment !== undefined ? Math.max(fullFrom, moment - 2 * 3600_000) : focused ? Math.max(fullFrom, focused.start - 900_000) : now - SESSION_SCOPE_MS);
	const to = preview?.[1] ?? (validRange ? Math.min(fullTo, Math.max(requestedTo, from + 60_000)) : selected ? (queryParams.has("all") ? fullTo : now) : moment !== undefined ? Math.max(from + 60_000, Math.min(fullTo, moment + 2 * 3600_000)) : focused ? Math.max(from + 60_000, Math.min(fullTo, focused.end + 900_000)) : fullTo);
	const window = timelineWindow(validRange ? requestedFrom : undefined, validRange ? requestedTo : undefined, Boolean(selected && queryParams.has("all")));
	const bands = useMemo(() => group(sessions, merged).filter((band) => band.members.some((s) => s.live) || (band.end >= from && band.start <= to)).sort((a, b) => Number(b.members.some((s) => s.ref === focus)) - Number(a.members.some((s) => s.ref === focus)) || rank(b, seen) - rank(a, seen) || a.start - b.start || a.key.localeCompare(b.key)), [sessions, merged, focus, from, to]);
	const unreadable = feeds.flatMap((f) => (f.value?.unreadable ?? []).filter((u) => !selected || (f.host.id === selected.host && u.threadId === selected.threadId)));
	const waitingOutside = sessions.filter((s) => attention(s, seen) && (s.end < from || s.start > to)).length;
	const bucketMs = feeds.find((f) => f.value)?.value?.bucketMs ?? 900_000;
	const overview = useMemo(() => {
		const totals = new Map<number, number>();
		for (const session of sessions) for (const bucket of session.buckets) if (bucket[0] < fullTo && bucket[0] + bucketMs > fullFrom) totals.set(bucket[0], (totals.get(bucket[0]) ?? 0) + bucket[unit]);
		const peak = Math.max(0, ...totals.values());
		const x = (t: number) => (t - fullFrom) / (fullTo - fullFrom) * X;
		return [...totals].map(([time, spend]) => {
			const h = peak ? spend / peak * 16 : 0;
			const start = Math.max(fullFrom, time), end = Math.min(fullTo, time + bucketMs);
			return `M${x(start)},${20 - h}H${x(end)}V${20 + h}H${x(start)}Z`;
		}).join("");
	}, [sessions, unit, fullFrom, fullTo, bucketMs]);
	const totals = useMemo(() => new Map(bands.map((band) => [band.key, laneTotal(band.buckets, band, [from, to], bucketMs, unit)])), [bands, from, to, bucketMs, unit]);
	const rangeTotal = [...totals.values()].reduce((sum, n) => sum + n, 0);
	const peak = useMemo(() => bands.reduce((max, band) => band.buckets.reduce((max, b) => b[0] < to && b[0] + bucketMs > from ? Math.max(max, b[unit]) : max, max), 0), [bands, unit, from, to, bucketMs]);
	const scale = peak ? 21 / peak : 0;
	const query = Object.fromEntries(queryParams);
	const change = (q: Record<string, string | undefined>) => href.page("timeline", [], { ...query, ...q });
	const update = (q: Record<string, string | undefined>) => {
		if (!selected) { navigate(change(q)); return; }
		const next = new URLSearchParams(queryParams);
		for (const [key, value] of Object.entries(q)) value === undefined ? next.delete(key) : next.set(key, value);
		setPanelQuery(next);
	};
	const zoom = (factor: number, center = (from + to) / 2) => {
		const span = Math.min(fullTo - fullFrom, Math.max(60_000, (to - from) * factor));
		const start = Math.max(fullFrom, Math.min(fullTo - span, center - span / 2));
		update({ from: String(Math.round(start)), to: String(Math.round(start + span)) });
	};
	useEffect(() => {
		const node = scrollRef.current;
		const wheel = (e: WheelEvent) => { if (e.ctrlKey || e.altKey || e.shiftKey) { e.preventDefault(); zoom(e.deltaY > 0 ? 1.3 : 0.77); } };
		node?.addEventListener("wheel", wheel, { passive: false });
		return () => node?.removeEventListener("wheel", wheel);
	});
	useEffect(() => { setHover("Hover a stream to inspect its bucket. Click to open the nearest entry."); }, [from, to, merged, unit]);
	const cycleWindow = () => {
		const next = nextTimelineWindow(window, Boolean(selected));
		const range = typeof next === "number" ? windowRange(next, Date.now()) : undefined;
		update({ from: range ? String(range[0]) : undefined, to: range ? String(range[1]) : undefined, focus: undefined, at: undefined, all: next === "Session life" ? "1" : undefined });
	};
	const first = Math.max(0, Math.min(bands.length - 1, Math.floor(scroll / ROW) - 3)), visible = bands.slice(first, first + 28);
	return <main className={`main cos-page${selected ? " cos-panel" : ""}`}>
		{readers}
		<header className="cos-header"><h1>Timeline</h1><span className="cos-meta">{sessions.length} Sessions · {bands.length} streams · {amount(unit, rangeTotal)} in range</span>{selected ? <a href={href.page("timeline", [], { focus: `${selected.host}/${selected.threadId}` })}>Open Timeline page ↗</a> : <a href={href.page("arcs")}>Arcs</a>}</header>
		<nav className="cos-toolbar" aria-label="Timeline controls">
			<span>Width</span>
			{selected ? <>
				<button aria-current={unit === 2 ? "true" : undefined} onClick={() => update({ unit: "dollars" })}>Dollars</button>
				<button aria-current={unit === 1 ? "true" : undefined} onClick={() => update({ unit: "tokens" })}>Tokens</button>
			</> : <>
				<a aria-current={unit === 2 ? "true" : undefined} href={change({ unit: "dollars" })}>Dollars</a>
				<a aria-current={unit === 1 ? "true" : undefined} href={change({ unit: "tokens" })}>Tokens</a>
			</>}
			<span className="cos-toolbar-divider" />
			<button className={`btn small cos-team-toggle ${merged ? "cos-team-merged" : "cos-team-separate"}`} aria-pressed={merged} title={merged ? "Separate members" : "Merge Teams"} onClick={() => update({ teams: merged ? "separate" : "merged" })}>{merged ? "Merge Teams" : "Separate members"}</button>
			<span className="spacer" />
			<button aria-label={`Time window: ${typeof window === "number" ? `${window} h` : window}`} title={`Show ${nextTimelineWindow(window, Boolean(selected))}${typeof nextTimelineWindow(window, Boolean(selected)) === "number" ? " h" : ""}`} onClick={cycleWindow}>{typeof window === "number" ? `${window} h` : window}</button>
		</nav>
		<FeedStatus feeds={feeds} connected={connected} />
		<p className="cos-caption">Time → · thickness = {unit === 2 ? "reported dollars" : "tokens (input + output + cache)"} / 15 min · lane number = its total in range · same scale: {unit === 2 ? money(peak) : tokens(peak)} max · needs you = a blocked pane or an error · new answer = an answer since you last opened the Session.</p>
		{unreadable.length > 0 && <p className="cos-caption">{unreadable.length === 1 ? "1 Session could not be read and is left out: " : `${unreadable.length} Sessions could not be read and are left out: `}{unreadable.slice(0, 3).map((u, i) => <Fragment key={u.ref}>{i ? ", " : ""}<a href={href.ref(u.ref)} title={u.message}>{u.title}</a></Fragment>)}{unreadable.length > 3 ? ", …" : ""}. The Session reader rejected {unreadable.length === 1 ? "its file" : "their files"} ({unreadable[0]!.message}); the copy refreshes when the Host sends new bytes.</p>}
		{waitingOutside > 0 && <p className="cos-caption">{waitingOutside} Sessions that need you are outside this time range.</p>}
		<div className="cos-axis"><span>Session / Team</span><div>{[0, 1, 2, 3, 4].map((i) => <time key={i}>{i === 4 && Math.abs(to - now) < 120_000 ? "Now · " : ""}{dateTime(from + (to - from) * i / 4)}</time>)}</div></div>
		<div className="cos-scroll" ref={scrollRef} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
			{!sessions.length && <p className="cos-empty">{feeds.some((f) => !f.value && !f.error) ? "Reading the Sessions…" : "No timestamped Sessions yet. Connect a Pi Host with Session copies to see its spend."}</p>}
			{sessions.length > 0 && !bands.length && <p className="cos-empty">No Sessions in this range. Adjust the range below.</p>}
			<div style={{ height: bands.length * ROW, position: "relative" }}><div style={{ position: "absolute", top: first * ROW, width: "100%" }}>{visible.map((band) => <Stream key={band.key} band={band} from={from} to={to} now={now} moment={moment} bucketMs={bucketMs} unit={unit} scale={scale} color={band.key.split("").reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) % 6} focus={band.members.some((s) => s.ref === focus)} onHover={setHover} seen={seen} total={totals.get(band.key) ?? 0} />)}</div></div>
		</div>
		<div className="cos-inspector" role="status">{hover}</div>
		<RangeBrush bounds={[fullFrom, fullTo]} range={[from, to]} overview={overview} onPreview={setPreview} onCommit={(range) => { setPreview(range); update({ from: String(range[0]), to: String(range[1]) }); }} />
	</main>;
}
