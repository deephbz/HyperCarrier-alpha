// Stage 2 of D15: the GUI asks Herdr to start or close a Pi agent. Herdr keeps owning panes, tabs, and workspaces;
// these dialogs only say where, and report what Herdr confirmed.

import { useState } from "react";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { hub, type HostState } from "../client.ts";
import { useFeeds } from "../context.ts";
import { MOD, go } from "../util.ts";
import { Modal } from "./Dialogs.tsx";

type Place = "right" | "down" | "workspace";
const LAST_KEY = "ampi.newAgent";

/** Where a new agent goes: beside the open Session (its pane, split right or down) or in a new Herdr workspace. */
export function NewAgentDialog({ hosts, defaultHost, beside, onClose }: { hosts: HostState[]; defaultHost?: string; beside?: ThreadSummary; onClose: () => void }) {
	const last = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as { host?: string; place?: Place; cwd?: Record<string, string> };
	const connected = hosts.filter((h) => h.status === "connected");
	const [host, setHost] = useState(defaultHost && hosts.some((h) => h.id === defaultHost) ? defaultHost : (last.host ?? connected[0]?.id ?? ""));
	const besidePane = beside?.location?.pane && host === defaultHost ? beside : undefined;
	const [chosen, setPlace] = useState<Place>(besidePane ? (last.place === "workspace" ? "right" : (last.place ?? "right")) : "workspace");
	// Without a Session in a pane on this Host there is nothing to sit beside.
	const place: Place = besidePane ? chosen : "workspace";
	const [cwd, setCwd] = useState(besidePane?.cwd ?? last.cwd?.[host] ?? "");
	const [name, setName] = useState("");
	const [label, setLabel] = useState("");
	const [prompt, setPrompt] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string>();
	const [started, setStarted] = useState<string>();
	// One ID per dialog: a double submit or a retry after a lost response must not start a second agent.
	const [requestId] = useState(() => crypto.randomUUID());
	const where = place === "workspace" ? "a new Herdr workspace" : `a pane ${place === "right" ? "to the right of" : "below"} ${besidePane?.title ?? "this Session"}`;
	const create = async () => {
		if (!cwd.trim()) return setError("Give the agent a working directory on the Host.");
		setBusy(true);
		setError(undefined);
		try {
			const res = await hub.request(host, "thread.create", {
				cwd: cwd.trim(),
				place: place === "workspace" ? { workspace: "new", ...(label.trim() ? { label: label.trim() } : {}) } : { beside: besidePane!.id, direction: place },
				...(name.trim() ? { name: name.trim() } : {}),
				...(prompt.trim() ? { prompt: prompt.trim() } : {}),
				requestId,
			});
			localStorage.setItem(LAST_KEY, JSON.stringify({ host, place, cwd: { ...last.cwd, [host]: cwd.trim() } }));
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
	return (
		<Modal onClose={onClose}>
			<h2>New agent</h2>
			<div className="field">
				Host
				<select value={host} onChange={(e) => setHost(e.target.value)} aria-label="Host">
					{hosts.map((h) => (
						<option key={h.id} value={h.id} disabled={h.status !== "connected"}>
							{h.label} {h.status === "connected" ? "" : `— ${h.status}`}
						</option>
					))}
				</select>
			</div>
			<div className="field">
				Where
				<div className="seg" role="group" aria-label="Where">
					{besidePane && (
						<>
							<button className={place === "right" ? "on" : ""} aria-pressed={place === "right"} onClick={() => setPlace("right")}>
								Beside, right
							</button>
							<button className={place === "down" ? "on" : ""} aria-pressed={place === "down"} onClick={() => setPlace("down")}>
								Beside, below
							</button>
						</>
					)}
					<button className={place === "workspace" ? "on" : ""} aria-pressed={place === "workspace"} onClick={() => setPlace("workspace")}>
						New workspace
					</button>
				</div>
			</div>
			<div className="field">
				Working directory
				<input value={cwd} placeholder="/path/on/the/host" onChange={(e) => setCwd(e.target.value)} aria-label="Working directory" />
			</div>
			<div className="field">
				Name (optional)
				<input value={name} placeholder="shown on the Herdr pane" onChange={(e) => setName(e.target.value)} aria-label="Name" />
			</div>
			{place === "workspace" && (
				<div className="field">
					Workspace label (optional)
					<input value={label} placeholder="the directory's name" onChange={(e) => setLabel(e.target.value)} aria-label="Workspace label" />
				</div>
			)}
			<div className="field">
				First message (optional)
				<textarea
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
					Herdr starts Pi in {where} on {hosts.find((h) => h.id === host)?.label ?? host}.
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
