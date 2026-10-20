import { useMemo, useState } from "react";
import type { PiTeamTask, TeamValue } from "../../../../src/pi/views/team.ts";
import { useHosts, useTopic } from "../../client.ts";
import { href } from "../../util.ts";
import "./team.css";

type Team = TeamValue["teams"][number];
const LABELS: Record<string, string> = { ready: "Ready", in_progress: "In progress", blocked: "Blocked", dependency_waiting: "Waiting on dependencies", goal_failed: "Goal failed", goal_achieved: "Goal achieved", cancelled: "Cancelled", legacy_completed: "Completed (legacy)" };
const label = (status: string) => LABELS[status] ?? status.replaceAll("_", " ");
const PAGE = 100;

function Owner({ team, owner, host }: { team: Team; owner?: string; host: string }) {
	const member = team.members.filter(m => m.member === owner);
	return member.length === 1 && member[0]!.threadId
		? <a className="ptb-owner" href={href.thread(host, member[0]!.threadId!)}>{owner}</a>
		: <span className="ptb-owner">{owner ?? "Unassigned"}</span>;
}

function TaskDetail({ task, team, host }: { task: PiTeamTask; team: Team; host: string }) {
	return <div className="ptb-detail">
		<p>{task.title}</p>
		<div><span className="ptb-id">{task.id}</span> · {label(task.status)} · <Owner team={team} owner={task.owner} host={host} /></div>
		<p>Depends on: {task.deps.length ? task.deps.join(", ") : "no Tasks"}</p>
		{task.updatedAt && <p>Updated {task.updatedAt}</p>}
	</div>;
}

/** Kahn layers preserve all prerequisite edges, including already-satisfied ones. */
function layout(tasks: PiTeamTask[]) {
	const ids = new Set(tasks.map(t => t.id));
	const layers = new Map<string, number>();
	let remaining = [...tasks];
	while (remaining.length) {
		const next = remaining.filter(t => t.deps.every(d => !ids.has(d) || layers.has(d)));
		if (!next.length) break;
		const additions = next.map(t => [t.id, Math.max(-1, ...t.deps.map(d => layers.get(d) ?? -1)) + 1] as const);
		for (const [id, layer] of additions) layers.set(id, layer);
		remaining = remaining.filter(t => !layers.has(t.id));
	}
	const cycle = remaining.length > 0;
	const end = Math.max(-1, ...layers.values()) + 1;
	for (const task of remaining) layers.set(task.id, end);
	const counts = new Map<number, number>();
	const nodes = tasks.map(task => {
		const layer = layers.get(task.id)!;
		const row = counts.get(layer) ?? 0;
		counts.set(layer, row + 1);
		return { task, x: 8 + layer * 176, y: 12 + row * 108 };
	});
	return { nodes, cycle, width: 16 + (Math.max(0, ...layers.values()) + 1) * 176 - 28, height: 24 + Math.max(1, ...counts.values()) * 108 - 16 };
}

function Graph({ tasks, team, host }: { tasks: PiTeamTask[]; team: Team; host: string }) {
	const graph = useMemo(() => layout([...tasks].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))), [tasks]);
	const [selected, select] = useState<string>();
	const byId = new Map(graph.nodes.map(node => [node.task.id, node]));
	const task = tasks.find(t => t.id === selected);
	const boundary = tasks.reduce((n, t) => n + t.deps.filter(d => !byId.has(d)).length, 0);
	return <>
		<p className="ptb-hint">Dependencies → · Scroll to explore. Select a Task for details.</p>
		{graph.cycle && <p className="ptb-notice">Some dependencies form a cycle. Unresolved Tasks appear in the last layer.</p>}
		{boundary > 0 && <p className="ptb-hint">{boundary} dependencies outside this page are listed in Task details.</p>}
		<div className="ptb-graph-scroll" tabIndex={0} role="region" aria-label="Task dependency graph">
			<div className="ptb-graph" style={{ width: graph.width, height: graph.height }}>
				<svg width={graph.width} height={graph.height} aria-hidden="true">
					<defs><marker id="ptb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
					{graph.nodes.flatMap(node => node.task.deps.map(dep => {
						const from = byId.get(dep);
						if (!from) return null;
						const x = from.x + 148, y = from.y + 46, target = node.y + 46;
						return <path key={`${node.task.id}/${dep}`} d={`M${x},${y} C${x + 14},${y} ${node.x - 14},${target} ${node.x - 2},${target}`} markerEnd="url(#ptb-arrow)" />;
					}))}
				</svg>
				{graph.nodes.map(({ task, x, y }) => <div key={task.id} className={`ptb-node ${selected === task.id ? "selected" : ""}`} style={{ left: x, top: y }}>
					<button onClick={() => select(task.id)} title={task.title} aria-pressed={selected === task.id}>
						<span className={`ptb-state state-${task.status}`}>{label(task.status)}</span><span className="ptb-node-title">{task.title}</span>
					</button>
					<div><span className="ptb-id">{task.id}</span><Owner team={team} owner={task.owner} host={host} /></div>
				</div>)}
			</div>
		</div>
		{task && <TaskDetail task={task} team={team} host={host} />}
	</>;
}

function Tasks({ team, host }: { team: Team; host: string }) {
	const [mode, setMode] = useState("list");
	const [page, setPage] = useState(0);
	const ordered = useMemo(() => [...team.tasks].sort((a, b) => Number(b.ready) - Number(a.ready) || Number(b.status === "blocked") - Number(a.status === "blocked") || a.status.localeCompare(b.status) || a.id.localeCompare(b.id, undefined, { numeric: true })), [team.tasks]);
	const currentPage = Math.min(page, Math.max(0, Math.ceil(ordered.length / PAGE) - 1));
	const tasks = ordered.slice(currentPage * PAGE, (currentPage + 1) * PAGE);
	const groups = new Map<string, PiTeamTask[]>();
	for (const task of tasks) {
		const key = task.ready ? "Ready frontier" : label(task.status);
		groups.set(key, [...(groups.get(key) ?? []), task]);
	}
	const unavailable = team.issues.some(i => i.startsWith("task_"));
	return <section aria-label="Tasks">
		<div className="ptb-task-head"><h3>Tasks <span>{unavailable ? "—" : team.tasks.length}</span></h3><div className="ptb-toggle" role="group" aria-label="Task view">
			{["list", "graph"].map(view => <button key={view} aria-pressed={mode === view} onClick={() => setMode(view)}>{view === "list" ? "List" : "Graph"}</button>)}
		</div></div>
		{unavailable ? <p className="ptb-notice">{team.issues.includes("task_reader_missing") ? "This Pi Team Bright version does not publish Tasks. Install a version with the public Task reader on this Host." : "Tasks could not be read. Ask the lead to check Pi Team Bright’s Task authority; this is not an empty graph."}</p>
			: !team.tasks.length ? <p className="ptb-hint">No Tasks yet: the lead has not applied a Task graph.</p>
			: mode === "graph" ? <Graph tasks={tasks} team={team} host={host} />
			: [...groups].map(([name, group]) => <section className="ptb-group" key={name} aria-label={name}>
				<h4>{name} <span>{group.length}</span></h4>
				{group.map(task => <div className="ptb-task" key={task.id}><details>
					<summary title={task.title}><span className={`ptb-dot state-${task.status}`} /><span className="ptb-title">{task.title}</span><span className="ptb-id">{task.id}</span></summary>
					<TaskDetail task={task} team={team} host={host} />
				</details><div className="ptb-assignee"><Owner team={team} owner={task.owner} host={host} /></div></div>)}
			</section>)}
		{ordered.length > PAGE && <nav className="ptb-pagination" aria-label="Task pages">
			<button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
			<span>{currentPage * PAGE + 1}–{Math.min((currentPage + 1) * PAGE, ordered.length)} of {ordered.length}</span>
			<button disabled={(currentPage + 1) * PAGE >= ordered.length} onClick={() => setPage(currentPage + 1)}>Next</button>
		</nav>}
	</section>;
}

export function TeamPanel({ host, threadId }: { host: string; threadId: string }) {
	const { value, stale, error } = useTopic(host, { kind: "view", view: "team", threadId });
	const { hosts } = useHosts();
	const away = hosts.find(h => h.id === host)?.status !== "connected";
	const failed = value && "error" in value;
	const team = value && !("error" in value) ? value : undefined;
	const availability = team?.availability;
	return <div className="ptb">
		{error || failed ? <p className="ptb-notice">Team view could not load. Reconnect this Host and reopen the panel.</p>
			: !value || availability === "loading" ? <p className="ptb-hint">Reading the Team…</p>
			: availability === "absent" ? <p className="ptb-notice">Pi Team Bright is not installed on {host}. Install it on that Host to read the Team.</p>
			: stale || away || !["available", "partial"].includes(availability!) ? <p className="ptb-notice">{away ? `${host} is away.` : "Pi Team Bright is unavailable."} Showing the last observation, not current state. Reconnect the Host or check Pi Team Bright there.</p>
			: availability === "partial" ? <p className="ptb-notice">Pi Team Bright returned an incomplete observation. Check the Team’s diagnostics on {host}.</p> : null}
		{team?.teams?.map(team => <section key={team.name}>
			<h2 title={team.name}>{team.name}</h2>
			<h3>Members <span>{team.members.length}</span></h3>
			<ul className="ptb-members">{team.members.map((m, i) => <li key={`${m.member}/${i}`}>
				<span className={`ptb-dot ${m.live ? "live" : ""}`} />
				{m.threadId ? <a href={href.thread(host, m.threadId)} title={`Open ${m.member}’s Session`}>{m.member}</a> : <span title="No Session copy available">{m.member}</span>}
				<span className="ptb-role">{m.role === "lead" ? "lead" : "worker"}</span>
				<span className="ptb-live">{m.status === "streaming" ? "working" : m.status === "tools" ? "running tools" : m.status}</span>
			</li>)}</ul>
			<Tasks team={team} host={host} />
			{team.issues.length > 0 && <details className="ptb-diagnostics"><summary>Read diagnostics</summary><ul>{team.issues.map(issue => <li key={issue}>{issue.replaceAll("_", " ")}</li>)}</ul></details>}
		</section>)}
		{team && availability === "available" && !team.teams?.length && <p className="ptb-hint">This Session has no recorded Team. Open a Team member’s Session.</p>}
	</div>;
}
