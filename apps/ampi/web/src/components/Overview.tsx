import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { ACTIVITY_LABEL, MOD, ago, arcNeedsYou, attentionOf, go, href, isBusy, needsYou } from "../util.ts";
import { useEffect, useRef, useState } from "react";
import { useKeepPlace } from "../keep-place.ts";
import { hasRealModel, useModels } from "../models.ts";
import { openAccounts } from "./Accounts.tsx";
import { ONBOARDING_KEY } from "./Dialogs.tsx";
import { useNow } from "../client.ts";
import { linkLine, linkView } from "./host-fold.ts";
import { hostLabel, isPiHost } from "./host-label.ts";
import type { HostThreads } from "./Sidebar.tsx";
import { ActivityIcon, ThreadBadges } from "./ThreadStatus.tsx";
import { emptyNote, reading, unavailable } from "../host-lists.ts";
import { arcCoverage, arcNeedsRows, coverageNote } from "../views/cos/needs.ts";

import { activeSpend } from "../views/cos/totals.ts";

function Step({ done, title, children, action }: { done: boolean | undefined; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
	return (
		<div className={`step ${done ? "done" : ""}`} data-step={title} data-done={done ? "yes" : "no"}>
			<span className="check">{done ? "✓" : ""}</span>
			<div className="what">
				<b>{title}</b>
				{children && <div className="hint">{children}</div>}
			</div>
			{!done && action}
		</div>
	);
}

/**
 * First-run checklist, computed from real state rather than ticked by hand: the local node answers, a real model is
 * signed in, a thread exists, a remote host is added. It stays until every required step is done or the owner hides it.
 */
function Onboarding({ data, onNew, onHostSetup, onHelp }: { data: HostThreads[]; onNew: () => void; onHostSetup: () => void; onHelp: () => void }) {
	const [hidden, setHidden] = useState(() => localStorage.getItem(ONBOARDING_KEY) === "1");
	const local = data.find((d) => d.host.kind === "local") ?? data[0];
	const connected = local?.host.status === "connected";
	const real = hasRealModel(useModels(local?.host.link, connected));
	const anyThread = data.some((d) => d.threads.some((t) => t.kind === "thread"));
	const remote = data.find((d) => d.host.kind === "ssh" || d.host.kind === "pi-ssh");
	const required = connected && real === true && anyThread;
	if (hidden || required) return null;
	return (
		<div className="onboarding" data-onboarding>
			<div style={{ display: "flex", alignItems: "baseline" }}>
				<h2>Set up AmPi</h2>
				<span style={{ flex: 1 }} />
				<button
					className="btn ghost small"
					onClick={() => {
						localStorage.setItem(ONBOARDING_KEY, "1");
						setHidden(true);
					}}
				>
					Hide
				</button>
			</div>
			<div className="hint" style={{ marginBottom: 6 }}>
				Three steps, about two minutes. Each turns green on its own. <a href="#" onClick={(e) => (e.preventDefault(), onHelp())}>Keys and help (?)</a>
			</div>
			<Step done={connected} title="This computer's node is running">
				{connected
					? `${local!.host.node?.hostname ?? "local"} · agents keep working when this window closes.`
					: "The hub is starting its local node. If this stays, run ampi doctor in a terminal."}
			</Step>
			<Step
				done={real}
				title="Sign in to a model"
				action={
					connected && (
						<button className="btn primary small" onClick={() => openAccounts(local!.host.link)}>
							Set up models
						</button>
					)
				}
			>
				{real
					? "A model is signed in on this computer."
					: "Use a subscription (Claude, ChatGPT) or an API key. Until then, threads run on the offline simulator, which only demonstrates the interface."}
			</Step>
			<Step
				done={anyThread}
				title="Start a thread"
				action={
					<button className="btn small" onClick={onNew}>
						New agent <span className="kbd">{MOD}N</span>
					</button>
				}
			>
				Pick a folder and say what you want done. The thread keeps running if you close this window.
			</Step>
			<Step
				done={remote !== undefined}
				title="Optional: add a remote machine over SSH"
				action={
					<button className="btn small" onClick={onHostSetup}>
						Remote host (?)
					</button>
				}
			>
				{remote
					? `${hostLabel(remote.host, data.map((d) => d.host))} is added.`
					: "Copy the setup prompt into a coding agent; it sets up SSH and the machine, then adds the Host to hub.json."}
			</Step>
		</div>
	);
}

type Row = { host: string; hostLabel: string; t: ThreadSummary };

type ListProps = { rows: Row[]; empty: string; reason?: (t: ThreadSummary) => string | undefined; link?: (r: Row) => string };
function List({ rows, empty, reason, link, id, page, onPage }: ListProps & { id: string; page: number; onPage: (page: number, pager: HTMLElement) => void }) {
	const start = Math.min(page * 12, Math.max(0, Math.ceil(rows.length / 12) - 1) * 12);
	if (rows.length === 0) return <div className="hint">{empty}</div>;
	return (
		<>
			<div style={{ minHeight: Math.min(12, rows.length) * 32 }}>
			{rows.slice(start, start + 12).map(({ host, hostLabel, t }) => (
				<a key={`${host}|${t.id}`} className="row" href={link?.({ host, hostLabel, t }) ?? href.thread(host, t.id)} data-thread={t.id} title={`${t.title || "Untitled Session"}\n${hostLabel} · ${reason?.(t) ?? t.preview ?? t.cwd}`}>
					<ActivityIcon t={t} />
					<span className="title">
						<span dir="auto">{t.title || "Untitled Session"}</span>
						<span className="hint"> · {hostLabel} · {reason?.(t) ?? t.preview ?? t.cwd}</span>
					</span>
					<ThreadBadges t={t} compact />
					<span className="sub">{ago(t.updatedAt)}</span>
				</a>
			))}
			</div>
			{rows.length > 12 && <div className="list-page" data-place={`pager:${id}`}>
				<button className="btn ghost small" disabled={start === 0} onClick={(e) => onPage(Math.max(0, page - 1), e.currentTarget.parentElement!)}>Previous</button>
				<span className="hint">{start + 1}–{Math.min(start + 12, rows.length)} of {rows.length.toLocaleString()}</span>
				<button className="btn ghost small" disabled={start + 12 >= rows.length} onClick={(e) => onPage(page + 1, e.currentTarget.parentElement!)}>Next</button>
			</div>}
		</>
	);
}

/**
 * The return-to-desk view (O1): what needs the owner and why, what is running, and what changed, across hosts. The
 * axes stay separate (P5): a thread can be running and need attention; idle never means done.
 */
export function Overview({ data, onNew, onHostSetup, onHelp }: { data: HostThreads[]; onNew: () => void; onHostSetup: () => void; onHelp: () => void }) {
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(false);
	const keepPlace = useKeepPlace(scroller, "[data-place]", "data-place", pinned);
	const now = useNow(data.some((d) => d.host.status !== "connected"));
	const [pages, setPages] = useState<Record<string, number>>({});
	const paging = (id: string) => ({ id, page: pages[id] ?? 0, onPage: (page: number, pager: HTMLElement) => { keepPlace.capture({ anchor: pager }); setPages((old) => ({ ...old, [id]: page })); } });
	const [since, setSince] = useState(() => Number(localStorage.getItem("ampi.overview.lastSeen")) || undefined);
	useEffect(() => {
		const remember = () => localStorage.setItem("ampi.overview.lastSeen", String(Date.now()));
		const visibility = () => {
			if (document.hidden) remember();
			else setSince(Number(localStorage.getItem("ampi.overview.lastSeen")) || undefined);
		};
		document.addEventListener("visibilitychange", visibility);
		return () => { remember(); document.removeEventListener("visibilitychange", visibility); };
	}, []);
	// The Host decides which Sessions are in scope (it keeps unknown-age and source-loss copies); count what it lists.
	const inScope = (t: ThreadSummary) => !t.archived;
	const hosts = data.map((d) => d.host);
	const rows: Row[] = data.flatMap((d) => d.threads.filter(inScope).map((t) => ({ host: d.host.link, hostLabel: hostLabel(d.host, hosts), t })));
	// One pass over the rows; Hosts that share a link share its counts.
	const perHost = new Map<string, { total: number; busy: number }>();
	for (const r of rows) {
		const c = perHost.get(r.host) ?? { total: 0, busy: 0 };
		c.total++;
		if (isBusy(r.t)) c.busy++;
		perHost.set(r.host, c);
	}
	const byRecent = (a: Row, b: Row) => b.t.updatedAt - a.t.updatedAt;
	// Live signals first; then the cached Arc Needs-you count.
	const signals = rows.filter((r) => attentionOf(r.t).length).sort(byRecent);
	const asks = arcNeedsRows(rows);
	const needs = rows.filter((r) => needsYou(r.t));
	const running = rows.filter((r) => isBusy(r.t)).sort(byRecent);
	const dayAgo = Date.now() - 24 * 3600_000;
	const weekAgo = Date.now() - 7 * 24 * 3600_000;
	const coverage = arcCoverage(rows, weekAgo);
	// An empty Arc Needs-you count gives no evidence that work finished.
	const finished = (t: ThreadSummary) => t.rarebit?.status === "finished" && t.rarebit.fresh;
	const open = (t: ThreadSummary) => Boolean(needsYou(t));
	const recent = rows.filter((r) => !isBusy(r.t) && !open(r.t) && finished(r.t) && r.t.updatedAt > weekAgo).sort(byRecent);
	// Idle is not done (P5): quiet threads without positive evidence of being finished stay on the board.
	const quiet = rows
		.filter((r) => !isBusy(r.t) && !open(r.t) && !finished(r.t) && r.t.kind !== "worker" && r.t.updatedAt > weekAgo)
		.sort(byRecent);
	const note = coverageNote(coverage, asks.length === 0);
	const teams = rows.filter((r) => r.t.team?.role === "lead").sort(byRecent);
	// Pi Hosts (D15 stage 1): agents start in Herdr, and there is no node to set up.
	const piOnly = data.length > 0 && data.every((d) => isPiHost(d.host));
	// One figure over both backends: the sum names the classes some of its Sessions do not count.
	const spend = activeSpend(rows.map((r) => r.t), dayAgo);
	const changed = rows.filter((r) => r.t.updatedAt > (since ?? dayAgo)).length;
	const loading = data.some(reading);
	const ended = unavailable(data);
	const updating = !loading && data.some((d) => d.updating);
	return (
		<div className="main">
			<div className="topbar">
				<b>Overview</b>
				<span className="crumbs">
					{loading ? "Reading Sessions…" : rows.length === 0 && ended ? ended : <>{rows.length.toLocaleString()} Session{rows.length === 1 ? "" : "s"} · {data.length} Host{data.length === 1 ? "" : "s"} · {spend.label} in Sessions active today</>}
				</span>
				{updating && <span className="hint" role="status">Updating…</span>}
				<span className="spacer" />
				<button className="btn primary small" onClick={onNew}>
					+ New agent
				</button>
			</div>
			<div className="scroll" ref={scroller} onScroll={keepPlace.onScroll} data-page-scroller tabIndex={-1}>
				<div className="overview">
					{!piOnly && <Onboarding data={data} onNew={onNew} onHostSetup={onHostSetup} onHelp={onHelp} />}
					<section className="attention-summary" aria-label="Activity since your last visit">
						<h1>{since ? "Since you last checked Overview" : "Recent activity"}</h1>
						<p>{loading ? "Reading Sessions…" : <>{changed.toLocaleString()} Session{changed === 1 ? "" : "s"} updated {since ? `since ${new Date(since).toLocaleString()}` : "in the last 24 hours"}. {needs.length > 0 ? `${needs.length.toLocaleString()} ${needs.length === 1 ? "has" : "have"} a signal that ${needs.length === 1 ? "it needs" : "they need"} you.` : "No Session has a positive signal that it needs you."}</>}</p>
						{data.some((d) => d.stale || d.host.status !== "connected") && <p className="hint">Counts are from local copies. Away Hosts may have newer activity; check their connection before relying on these counts.</p>}
						<a href={href.page("timeline")}>See changes in Timeline <span aria-hidden="true">↗</span></a>
					</section>
					<div className="ov-hosts">
						{data.map((d) => { const { host, threads } = d; return (
							<div className="ov-host" key={host.link} data-host={host.id}>
								<span className={`dot ${host.status}`} />
								<b>{hostLabel(host, hosts)}</b>
								<span className="hint">
									{host.status === "connected"
										? reading(d) ? "Reading Sessions…" : d.error ? d.error : `${host.node?.hostname ? `${host.node.hostname} · ` : ""}${perHost.get(host.link)?.busy ?? 0} running · ${(perHost.get(host.link)?.total ?? 0).toLocaleString()} Sessions in scope`
										: linkLine(linkView(host, now))}
								</span>
							</div>
						); })}
					</div>
					{rows.length === 0 ? <div className="empty">{emptyNote(data)}</div> : <div className="ov-grid">
						<div className="ov-card" data-card="needs">
							<h2>
								Needs you <span className="hint">{needs.length.toLocaleString()}</span>
							</h2>
							{(signals.length > 0 || asks.length === 0) && <List {...paging("needs")}
								rows={signals}
								empty="No error or waiting pane. Idle threads are not necessarily done."
								reason={(t) => attentionOf(t).map((a) => `${a.source}: ${a.reason}`).join(" · ")}
							/>}
							{asks.length > 0 && <List {...paging("needs-arc")} rows={asks} empty="" reason={(t) => `${arcNeedsYou(t)}${t.arc?.stale ? " · Arc out of date" : ""}`} />}
							{note && <p className="hint" data-arc-coverage>{note}</p>}
						</div>
						<div className="ov-card" data-card="running">
							<h2>
								Running now <span className="hint">{running.length.toLocaleString()}</span>
							</h2>
							<List {...paging("running")} rows={running} empty="No agent is working right now." reason={(t) => ACTIVITY_LABEL[t.activity]} />
						</div>
						<div className="ov-card" data-card="teams">
							<h2>Teams <span className="hint">{teams.length.toLocaleString()}</span></h2>
							<List {...paging("teams")} rows={teams} empty="No Team leads. Start one from a thread." reason={(t) => t.team?.teamId} />
						</div>
						<div className="ov-card" data-card="quiet">
							<h2>Quiet, not marked finished <span className="hint">{quiet.length.toLocaleString()}</span></h2>
							<List {...paging("quiet")}
								rows={quiet}
								empty="Every idle thread appears finished."
								reason={(t) => (t.arc ? (t.arc!.stale ? `Arc out of date · ${t.arc!.stale} new since build` : "No completion signal") : t.rarebit ? (t.rarebit.status === "error" ? "Summary failed" : t.rarebit.fresh ? "Summary up to date" : "Summary out of date") : t.ref ? "no Arc yet" : "no Summary yet")}
							/>
						</div>
						<div className="ov-card" data-card="recent">
							<h2>Appear finished (this week) <span className="hint">{recent.length.toLocaleString()}</span></h2>
							<List {...paging("recent")} rows={recent} empty="No fresh Summary says a thread finished." />
						</div>
					</div>}
				</div>
			</div>
		</div>
	);
}
