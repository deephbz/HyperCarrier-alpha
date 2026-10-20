import { useMemo, useState } from "react";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { useTopic } from "../client.ts";
import { useFeeds } from "../context.ts";
import { ACTIVITY_LABEL, ago, clock, go, isBusy } from "../util.ts";

// biome-ignore lint: team view is loosely typed JSON
type Any = any;

const STATUS_LABEL: Record<string, string> = {
	dependency_waiting: "waiting",
	ready: "ready",
	in_progress: "in progress",
	blocked: "blocked",
	goal_achieved: "achieved",
	goal_failed: "failed",
	cancelled: "cancelled",
};

const NODE_W = 128;
const NODE_H = 44;
const GAP_X = 34;
const GAP_Y = 14;

/** A layered DAG: columns by dependency depth, needs drawn as edges left → right. */
function Graph({ tasks, selected, onSelect }: { tasks: Any[]; selected?: string; onSelect: (key: string) => void }) {
	const layout = useMemo(() => {
		const byKey = new Map(tasks.map((t) => [t.key, t]));
		const depth = new Map<string, number>();
		const d = (key: string, seen = new Set<string>()): number => {
			if (depth.has(key)) return depth.get(key)!;
			if (seen.has(key)) return 0;
			seen.add(key);
			const t = byKey.get(key);
			const value = t && t.needs.length ? 1 + Math.max(...t.needs.map((n: string) => d(n, seen))) : 0;
			depth.set(key, value);
			return value;
		};
		for (const t of tasks) d(t.key);
		const columns: string[][] = [];
		for (const t of tasks) (columns[depth.get(t.key)!] ??= []).push(t.key);
		const pos = new Map<string, { x: number; y: number }>();
		columns.forEach((col, ci) => col.forEach((key, ri) => pos.set(key, { x: 10 + ci * (NODE_W + GAP_X), y: 10 + ri * (NODE_H + GAP_Y) })));
		const width = 20 + columns.length * (NODE_W + GAP_X) - GAP_X;
		const height = 20 + Math.max(1, ...columns.map((c) => c.length)) * (NODE_H + GAP_Y) - GAP_Y;
		return { pos, width, height, byKey };
	}, [tasks]);
	return (
		<div className="graph">
			{/* Scales down to the panel width (never up), so a wide graph stays whole instead of clipping. */}
			<svg viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%" style={{ maxWidth: layout.width, display: "block" }} role="img" aria-label="Task graph">
				<defs>
					<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
						<path d="M0,0 L10,5 L0,10 z" fill="var(--text-3)" />
					</marker>
				</defs>
				{tasks.flatMap((t) =>
					t.needs.map((need: string) => {
						const a = layout.pos.get(need);
						const b = layout.pos.get(t.key);
						if (!a || !b) return null;
						const x1 = a.x + NODE_W;
						const y1 = a.y + NODE_H / 2;
						const x2 = b.x;
						const y2 = b.y + NODE_H / 2;
						const mid = (x1 + x2) / 2;
						return (
							<path key={`${need}-${t.key}`} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 2},${y2}`} fill="none" stroke="var(--border-strong)" strokeWidth="1.5" markerEnd="url(#arrow)" />
						);
					}),
				)}
				{tasks.map((t) => {
					const p = layout.pos.get(t.key)!;
					const tone =
						t.derived === "goal_achieved" ? "#16a34a" : t.derived === "in_progress" ? "var(--accent)" : t.derived === "ready" ? "#0284c7" : t.derived === "goal_failed" || t.derived === "blocked" ? "var(--err)" : "var(--border-strong)";
					return (
						<g key={t.key} transform={`translate(${p.x},${p.y})`} onClick={() => onSelect(t.key)} style={{ cursor: "pointer" }} data-task={t.key}>
							<rect width={NODE_W} height={NODE_H} rx="8" fill="var(--bg-elev)" stroke={selected === t.key ? "var(--accent)" : tone} strokeWidth={selected === t.key ? 2.5 : 1.5} />
							<rect width="4" height={NODE_H - 12} x="6" y="6" rx="2" fill={tone} />
							<text x="16" y="18" fontSize="12" fontWeight="600" fill="var(--text)">
								{t.key.length > 18 ? `${t.key.slice(0, 17)}…` : t.key}
							</text>
							<text x="16" y="34" fontSize="11" fill="var(--text-3)">
								{STATUS_LABEL[t.derived] ?? t.derived} · {t.assignee}
							</text>
						</g>
					);
				})}
			</svg>
		</div>
	);
}

export function TeamPanel({ host, threadId, summary }: { host: string; threadId: string; summary?: ThreadSummary }) {
	const teamId = summary?.team?.teamId ?? threadId;
	const { value } = useTopic(host, { kind: "team", teamId });
	const feeds = useFeeds();
	const [selected, setSelected] = useState<string>();
	const threads = new Map((feeds[host]?.threads ?? []).map((t) => [t.id, t]));
	if (!value) return <div className="empty">Loading…</div>;
	if (!value.team)
		return (
			<div className="empty">
				This thread does not lead a Team.
				<div className="hint" style={{ marginTop: 8 }}>
					Ask the agent to split work into a Team (team_create, ensure_worker, task_graph_apply). Workers appear here and as subthreads.
				</div>
			</div>
		);
	const task = value.tasks.find((t: Any) => t.key === selected);
	const counts: Record<string, number> = {};
	for (const t of value.tasks) counts[t.derived] = (counts[t.derived] ?? 0) + 1;
	return (
		<div data-panel="team">
			<h3>
				Team {value.team.name} · {value.team.status}
			</h3>
			<div className="hint" style={{ marginBottom: 8 }}>
				{value.team.purpose}
				{threadId !== value.leadThreadId && (
					<>
						{" · "}
						<a href="#" onClick={(e) => (e.preventDefault(), go(host, value.leadThreadId))}>
							open lead
						</a>
					</>
				)}
			</div>
			{(() => {
				const blocked = value.tasks.filter((t: Any) => t.derived === "blocked" || (t.derived === "goal_failed" && !String(t.derivedReason ?? "").startsWith("dependency")));
				const late = value.deliveries.filter((d: Any) => !d.settled && Date.now() - d.acceptedAt > 120_000);
				const alerts = [...value.alerts].reverse().slice(0, 3);
				const achieved = counts.goal_achieved ?? 0;
				return (
					<div className={`task-card ${blocked.length || late.length ? "exception" : ""}`} data-team-exceptions={blocked.length + late.length}>
						{blocked.length === 0 && late.length === 0 ? (
							<div className="hint">
								No exceptions · {achieved} of {value.tasks.length} Tasks achieved
							</div>
						) : (
							<>
								{blocked.map((t: Any) => (
									<div key={t.key} style={{ cursor: "pointer" }} onClick={() => setSelected(t.key)}>
										◆! <b>{t.key}</b> {STATUS_LABEL[t.derived]} ({t.assignee}){t.evidence ? ` — ${String(t.evidence).slice(0, 120)}` : ""}
									</div>
								))}
								{late.map((d: Any) => (
									<div key={d.id}>
										◆! {d.kind} notice for <b>{d.ref}</b> to {d.to} not answered for {ago(d.acceptedAt)}
									</div>
								))}
							</>
						)}
						{alerts.map((a: Any) => (
							<div key={a.id ?? a.ts} className="hint">
								alert {a.from} → {a.to}: {String(a.text ?? "").slice(0, 120)}
							</div>
						))}
					</div>
				);
			})()}
			<h3>Workers</h3>
			{value.workers.length === 0 && <div className="hint">No Workers yet.</div>}
			{value.workers.map((w: Any) => {
				const t = threads.get(w.threadId);
				const current = value.tasks.find((x: Any) => x.assignee === w.name && (x.derived === "in_progress" || x.derived === "blocked"));
				return (
					<div key={w.name} className="worker-row" onClick={() => go(host, w.threadId)} data-worker={w.name}>
						{t && isBusy(t) ? <span className="spinner" /> : <span className="idle-dot" />}
						<b>{w.name}</b>
						<span className="hint">
							{w.membership.active ? (t ? ACTIVITY_LABEL[t.activity] : "…") : `ended (${w.membership.deactivationReason ?? "stopped"})`}
						</span>
						<span className="scope">
							{current ? (
								<>
									holds <b>{current.key}</b> ({STATUS_LABEL[current.derived]}) ·{" "}
								</>
							) : value.tasks.some((x: Any) => x.assignee === w.name && !["goal_achieved", "goal_failed", "cancelled"].includes(x.derived)) ? (
								"waiting for its next Task · "
							) : (
								"all its Tasks are done · "
							)}
							{w.scope}
							{t?.lastError ? ` · error: ${t.lastError}` : ""}
						</span>
					</div>
				);
			})}
			<h3>
				Task graph · {value.graphVersion} ·{" "}
				{Object.entries(counts)
					.map(([k, n]) => `${n} ${STATUS_LABEL[k] ?? k}`)
					.join(", ")}
			</h3>
			{value.tasks.length === 0 ? <div className="hint">No Tasks yet.</div> : <Graph tasks={value.tasks} selected={selected} onSelect={setSelected} />}
			{task && (
				<div className="task-card" data-task-card={task.key}>
					<div className="t">
						{task.key} <span className={`status-pill ${task.derived}`}>{STATUS_LABEL[task.derived] ?? task.derived}</span>
						{task.derivedReason && <span className="hint">{task.derivedReason}</span>}
					</div>
					<div style={{ fontWeight: 500, marginTop: 2 }}>{task.title}</div>
					<div className="g">{task.goal}</div>
					<div className="hint">
						assignee {task.assignee} · version {task.version} · {task.attempts.length} attempt(s)
					</div>
					<div className="g">Context: {task.current_context}</div>
					{task.evidence && <div className="ev">{task.evidence}</div>}
				</div>
			)}
			<h3>Tasks</h3>
			{value.tasks.map((t: Any) => (
				<div key={t.key} className="task-card" onClick={() => setSelected(t.key)} style={{ cursor: "pointer" }}>
					<div className="t">
						<span className={`status-pill ${t.derived}`}>{STATUS_LABEL[t.derived] ?? t.derived}</span> {t.title}
					</div>
					<div className="hint">
						{t.key} → {t.assignee}
						{t.needs.length ? ` · after ${t.needs.join(", ")}` : ""}
					</div>
				</div>
			))}
			<details className="team-log">
				<summary>
					Delivery log · {value.deliveries.filter((d: Any) => d.settled).length} answered, {value.deliveries.filter((d: Any) => !d.settled).length} in flight
				</summary>
				<div className="hint" style={{ margin: "4px 0 6px" }}>
					Each notice is accepted with the change that caused it, then submitted to the Worker's thread and answered at its next turn boundary.
				</div>
				{value.deliveries.length === 0 && <div className="hint">Nothing delivered yet.</div>}
				{[...value.deliveries].reverse().slice(0, 30).map((d: Any) => (
					<div key={d.id} className="hint" style={{ display: "flex", gap: 6 }}>
						<span style={{ minWidth: 48 }}>{clock(d.acceptedAt)}</span>
						<span style={{ flex: 1 }}>
							{d.kind} notice · {d.ref} → {d.to}
						</span>
						<span>{d.settled ?? (d.submittedAt ? "submitted" : "accepted")}</span>
					</div>
				))}
			</details>
			<details className="team-log">
				<summary>Recent events</summary>
			{[...value.events].reverse().slice(0, 25).map((e: Any) => (
				<div key={e.seq} className="hint">
					{ago(e.ts)} · {e.actor}: {e.kind.replace(/_/g, " ")}
					{e.task ? ` ${e.task}` : ""}
					{e.detail ? ` — ${String(e.detail).replace(/\bv_[0-9a-f]{8,}\b/g, "").slice(0, 80)}` : ""}
				</div>
			))}
			</details>
		</div>
	);
}
