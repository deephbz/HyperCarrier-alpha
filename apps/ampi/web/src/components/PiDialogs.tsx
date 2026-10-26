// Stage 2 of D15: the GUI asks Herdr to start or close a Pi agent. Herdr keeps owning panes, tabs, and workspaces;
// these dialogs only say where, and report what Herdr confirmed. New agent also starts durable threads (node tabs).

import { useEffect, useRef, useState } from "react";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { findHost, hub, type HostState, useTopic } from "../client.ts";
import { useFeeds } from "../context.ts";
import { MOD, go } from "../util.ts";
import { Modal } from "./Dialogs.tsx";
import { hostLabel, hostLabelFor, isPiHost } from "./host-label.ts";
import type { ModelChoice } from "./ThreadView.tsx";

type Place = "right" | "down" | "beside" | "new";
const LAST_KEY = "ampi.newAgent";

/**
 * The one New agent dialog. The Host select drives its shape. On a Pi Host, Herdr starts Pi beside the open
 * Session's pane (right or below) or in a new workspace. On a durable node, the thread opens beside the open thread
 * in its tab, or in a new tab, and the dialog offers the node's models.
 */
export function NewAgentDialog({ hosts, defaultHost, beside, onClose }: { hosts: HostState[]; defaultHost?: string; beside?: ThreadSummary; onClose: () => void }) {
	const last = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as { host?: string; place?: Place; cwd?: Record<string, string>; model?: Record<string, string> };
	const connected = hosts.filter((h) => h.status === "connected");
	const routed = findHost(hosts, defaultHost);
	// New work starts on durable threads: from a Pi Session the default is the durable source of the same Host.
	const durableTwin = routed && isPiHost(routed) ? hosts.find((h) => h.id === routed.id && !isPiHost(h) && h.status === "connected") : undefined;
	const defaultDurable = !routed ? connected.find((h) => !isPiHost(h)) : undefined;
	const [host, setHost] = useState(durableTwin?.link ?? routed?.link ?? defaultDurable?.link ?? findHost(hosts, last.host)?.link ?? connected[0]?.link ?? hosts[0]?.link ?? "");
	const pi = isPiHost(findHost(hosts, host));
	// Beside needs the open thread on this source: a Herdr pane on Pi, an open tab on a durable node.
	const besideHere = beside && host === routed?.link && (pi ? beside.location?.pane : beside.location?.workspace && !beside.closed) ? beside : undefined;
	const [chosen, setPlace] = useState<Place>();
	// Pi keeps its base rule: beside the open pane unless the owner picks New workspace in this dialog. A durable
	// node remembers the last choice. Without the open thread on this source there is nothing to sit beside.
	const pick = chosen ?? (pi ? (last.place === "down" ? "down" : "right") : last.place);
	const place: Place = !besideHere || pick === "new" ? "new" : !pi ? "beside" : pick === "down" ? "down" : "right";
	const [cwd, setCwd] = useState(besideHere?.cwd ?? last.cwd?.[host] ?? "");
	const [dirs, setDirs] = useState<{ path: string; parent: string; dirs: string[] }>();
	const [models, setModels] = useState<ModelChoice[]>([]);
	const [model, setModel] = useState(last.model?.[host] ?? "");
	const [name, setName] = useState("");
	const [label, setLabel] = useState("");
	const [prompt, setPrompt] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string>();
	const [started, setStarted] = useState<string>();
	// One ID per dialog: a double submit or a retry after a lost response must not start a second agent.
	const [requestId] = useState(() => crypto.randomUUID());
	const first = useRef(true);
	useEffect(() => {
		if (!first.current) {
			setCwd(last.cwd?.[host] ?? "");
			setModel(last.model?.[host] ?? "");
		}
		first.current = false;
		if (pi) return setModels([]);
		hub.request(host, "models.list").then(setModels, () => setModels([]));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [host]);
	useEffect(() => {
		if (pi) return setDirs(undefined);
		const timer = setTimeout(() => {
			hub.request(host, "fs.dirs", { path: cwd }).then(setDirs, () => setDirs(undefined));
		}, 150);
		return () => clearTimeout(timer);
	}, [host, cwd, pi]);
	const chosenLabel = hostLabelFor(host, hosts);
	const where = pi
		? place === "new" ? "a new Herdr workspace" : `a pane ${place === "right" ? "to the right of" : "below"} ${besideHere?.title ?? "this Session"}`
		: place === "beside" ? `${besideHere?.title ?? "this thread"}'s tab, after it` : "a new tab";
	const create = async () => {
		const dir = (pi ? cwd : (dirs?.path ?? cwd)).trim();
		if (pi && !dir) return setError("Give the agent a working directory on the Host.");
		setBusy(true);
		setError(undefined);
		try {
			const [provider, ...id] = model.split("/");
			const placement = place === "new" ? { workspace: "new" as const, ...(label.trim() ? { label: label.trim() } : {}) } : { beside: besideHere!.id, ...(pi ? { direction: place as "right" | "down" } : {}) };
			const res = (await hub.request(host, "thread.create", {
				cwd: dir,
				place: placement,
				...(pi && name.trim() ? { name: name.trim() } : {}),
				...(!pi && model ? { model: { provider, modelId: id.join("/") } } : {}),
				...(prompt.trim() ? { prompt: prompt.trim() } : {}),
				requestId,
			} as never)) as { threadId: string; evidence?: string; pane?: string; submitted?: { error?: { message: string } } };
			localStorage.setItem(LAST_KEY, JSON.stringify({ host, place, cwd: { ...last.cwd, [host]: dir }, model: { ...last.model, [host]: model } }));
			// The Session's ID is chosen before Herdr runs anything, so it can be opened at once, even before Pi writes it.
			const problems = [
				res.evidence === "unknown" ? `Herdr opened pane ${res.pane ?? ""} but did not confirm that Pi started.` : "",
				res.submitted?.error ? `The first message was not sent: ${res.submitted.error.message}` : "",
			].filter(Boolean);
			if (!problems.length) {
				onClose();
				go(host, res.threadId);
				return;
			}
			setStarted(res.threadId);
			setNote(problems.join(" "));
			setBusy(false);
		} catch (e) {
			setError((e as Error).message);
			setBusy(false);
		}
	};
	const option = (value: Place, text: string) => (
		<button key={value} className={place === value ? "on" : ""} aria-pressed={place === value} onClick={() => setPlace(value)}>
			{text}
		</button>
	);
	return (
		<Modal onClose={onClose}>
			<h2>New agent</h2>
			<div className="field">
				Host
				<select value={host} onChange={(e) => setHost(e.target.value)} aria-label="Host">
					{hosts.map((h) => (
						<option key={h.link} value={h.link} disabled={h.status !== "connected"}>
							{hostLabel(h, hosts)}{" "}
							{h.status === "connected" ? "" : `— ${h.status}`}
						</option>
					))}
				</select>
			</div>
			<div className="field">
				Where
				<div className="seg" role="group" aria-label="Where">
					{besideHere && (pi ? [option("right", "Beside, right"), option("down", "Beside, below")] : option("beside", "Beside this thread, in its tab"))}
					{option("new", pi ? "New workspace" : "New tab")}
				</div>
			</div>
			<div className="field">
				Working directory
				<input value={cwd} placeholder={pi ? "/path/on/the/host" : (dirs?.path ?? "~")} onChange={(e) => setCwd(e.target.value)} aria-label="Working directory" />
				{dirs && (
					<div className="dirlist quiet-scroll">
						<button onClick={() => setCwd(dirs.parent)}>..</button>
						{dirs.dirs.map((d) => (
							<button key={d} onClick={() => setCwd(`${dirs.path.replace(/\/$/, "")}/${d}`)}>
								{d}/
							</button>
						))}
					</div>
				)}
			</div>
			{pi ? (
				<div className="field">
					Name (optional)
					<input value={name} placeholder="shown on the Herdr pane" onChange={(e) => setName(e.target.value)} aria-label="Name" />
				</div>
			) : (
				<div className="field">
					Model
					<select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
						<option value="">Host default</option>
						{models.map((m) => (
							<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
								{m.provider}/{m.id} {m.name !== m.id ? `— ${m.name}` : ""}
							</option>
						))}
					</select>
				</div>
			)}
			{place === "new" && (
				<div className="field">
					{pi ? "Workspace label" : "Tab label"} (optional)
					<input value={label} placeholder="the directory's name" onChange={(e) => setLabel(e.target.value)} aria-label={pi ? "Workspace label" : "Tab label"} />
				</div>
			)}
			<div className="field">
				First message (optional)
				<textarea
					className="quiet-scroll"
					rows={3}
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					aria-label="First message"
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void create();
					}}
				/>
			</div>
			{error && <div className="err-box" role="alert">{error} Check the Host and directory, then retry. Your message is kept here.</div>}
			{note && <div className="attn-box" role="status">{note} Open the agent to check its state.</div>}
			<div className="actions">
				<span className="hint" style={{ marginRight: "auto" }}>
					{pi ? `Herdr starts Pi in ${where} on ${chosenLabel}.` : `The durable node on ${chosenLabel} opens the thread in ${where}.`}
				</span>
				<button className="btn" onClick={onClose}>
					{started ? "Close" : "Cancel"}
				</button>
				{started && (
					<button
						className="btn primary"
						onClick={() => {
							onClose();
							go(host, started);
						}}
					>
						Open the agent
					</button>
				)}
				{!started && (
					<button className="btn primary" disabled={busy || !host} onClick={() => void create()}>
						{busy ? "Starting…" : <>Start {MOD}↵</>}
					</button>
				)}
			</div>
		</Modal>
	);
}

/** Closing kills the agent's pane in Herdr; the transcript stays readable from its copy. */
export function ArchiveThreadDialog({ host, summary, onClose }: { host: string; summary: ThreadSummary; onClose: () => void }) {
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const teamId = summary.team?.role === "lead" ? summary.team.teamId : undefined;
	const { value: team } = useTopic(host, teamId ? { kind: "team", teamId } : undefined);
	const workerCount = team?.workers?.filter((worker: { membership: { active: boolean } }) => worker.membership.active).length;
	const archive = async () => {
		setBusy(true);
		setError(undefined);
		try {
			if (summary.activity !== "idle") await hub.request(host, "thread.abort", { threadId: summary.id });
			await hub.request(host, "thread.archive", { threadId: summary.id, archived: true });
			onClose();
		} catch (e) {
			setError((e as Error).message);
			setBusy(false);
		}
	};
	return <Modal onClose={onClose}>
		<h2>{summary.activity === "idle" ? `Archive ${summary.title}?` : "This thread is working. Stop it and archive?"}</h2>
		<p>Archive stops this thread's work and puts it away. Its history stays readable. You can unarchive it or send a message to continue.</p>
		{teamId && <p>{workerCount === undefined ? "Archiving also ends its Team and archives its Workers." : `Archiving also ends its Team and archives ${workerCount} ${workerCount === 1 ? "Worker" : "Workers"}.`}</p>}
		{error && <div className="err-box" role="alert">{error}</div>}
		<div className="actions"><button className="btn" disabled={busy} onClick={onClose}>Cancel</button><button className="btn danger" disabled={busy} onClick={() => void archive()}>{busy ? "Archiving…" : summary.activity === "idle" ? "Archive" : "Stop and archive"}</button></div>
	</Modal>;
}

export function CloseAgentDialog({ host, summary, onClose }: { host: string; summary: ThreadSummary; onClose: () => void }) {
	const [error, setError] = useState<{ code?: string; message: string }>();
	const [busy, setBusy] = useState(false);
	const running = summary.activity !== "idle";
	const place = [summary.location?.workspaceLabel, summary.location?.tabLabel].filter(Boolean).join(" › ");
	const close = async (lastPane = false) => {
		setBusy(true);
		setError(undefined);
		try {
			await hub.request(host, "thread.close", { threadId: summary.id, ...(lastPane ? { lastPane: true } : {}) });
			onClose();
		} catch (e) {
			const err = e as Error & { code?: string };
			setError({ code: err.code ?? (/last pane|final_pane/i.test(err.message) ? "final_pane" : undefined), message: err.message });
			setBusy(false);
		}
	};
	const stop = async () => {
		setBusy(true);
		try {
			await hub.request(host, "thread.abort", { threadId: summary.id });
			onClose();
		} catch (e) {
			setError({ message: (e as Error).message });
			setBusy(false);
		}
	};
	const lastPane = error?.code === "final_pane";
	return (
		<Modal onClose={onClose}>
			<h2>Close the pane of {summary.title}?</h2>
			<p>
				Herdr closes its pane{place ? ` in ${place}` : ""} and Pi exits{running ? ", interrupting the turn it is running now" : ""}. Text typed in the
				pane but not sent is lost. The transcript stays here under “Not in a pane”, where Resume starts it again.
			</p>
			{summary.team?.role === "lead" && <p className="hint">This is a Pi Team Bright lead. Its workers keep running in their own panes.</p>}
			{lastPane ? (
				<div className="err-box" role="alert">It is the last pane in its Herdr workspace; the workspace may close with it. Close it anyway?</div>
			) : (
				error && <div className="err-box" role="alert">{error.message} Check the Host connection and try again.</div>
			)}
			<div className="actions">
				<button className="btn" onClick={onClose}>
					Cancel
				</button>
				{running && !lastPane && (
					<button className="btn" disabled={busy} onClick={() => void stop()} title="Interrupt the turn and keep the pane">
						Stop the turn instead
					</button>
				)}
				<button className="btn danger" disabled={busy} onClick={() => void close(lastPane)}>
					{busy ? "Closing…" : lastPane ? "Close it anyway" : "Close pane"}
				</button>
			</div>
		</Modal>
	);
}

/** Close is a suspend: the Session's file stays on its Host, and Resume starts Pi on it again in a pane. */
export function ResumeAgentDialog({ host, summary, onClose }: { host: string; summary: ThreadSummary; onClose: () => void }) {
	const feeds = useFeeds();
	// Sessions running in a pane on this Host, the ones in the same directory first: the likely neighbours.
	const neighbours = (feeds[host]?.threads ?? [])
		.filter((t) => t.live && t.location?.pane && t.id !== summary.id)
		.sort((a, b) => Number(b.cwd === summary.cwd) - Number(a.cwd === summary.cwd) || b.updatedAt - a.updatedAt);
	const [beside, setBeside] = useState(neighbours[0]?.id ?? "");
	const [direction, setDirection] = useState<"right" | "down">("right");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [requestId] = useState(() => crypto.randomUUID());
	const resume = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await hub.request(host, "thread.resume", {
				threadId: summary.id,
				place: beside ? { beside, direction } : { workspace: "new" },
				requestId,
			});
			onClose();
		} catch (e) {
			setError((e as Error).message);
			setBusy(false);
		}
	};
	return (
		<Modal onClose={onClose}>
			<h2>Resume {summary.title}</h2>
			<p>Herdr starts Pi on this Session again, in {summary.cwd || "its directory"}. The transcript continues where it stopped.</p>
			<div className="field">
				Where
				<select value={beside} onChange={(e) => setBeside(e.target.value)} aria-label="Where">
					{neighbours.map((t) => (
						<option key={t.id} value={t.id}>
							Beside {t.title} ({[t.location?.workspaceLabel, t.location?.tabLabel].filter(Boolean).join(" › ")})
						</option>
					))}
					<option value="">In a new Herdr workspace</option>
				</select>
			</div>
			{beside && (
				<div className="seg" role="group" aria-label="Split">
					<button className={direction === "right" ? "on" : ""} aria-pressed={direction === "right"} onClick={() => setDirection("right")}>
						Right
					</button>
					<button className={direction === "down" ? "on" : ""} aria-pressed={direction === "down"} onClick={() => setDirection("down")}>
						Below
					</button>
				</div>
			)}
			{error && <div className="err-box" role="alert">{error} Check the Host connection and try again.</div>}
			<div className="actions">
				<button className="btn" onClick={onClose}>
					Cancel
				</button>
				<button className="btn primary" disabled={busy} onClick={() => void resume()}>
					{busy ? "Resuming…" : "Resume"}
				</button>
			</div>
		</Modal>
	);
}
