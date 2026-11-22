// Stage 2 of D15: the GUI asks Herdr to start or close a Pi agent. Herdr keeps owning panes, tabs, and workspaces;
// these dialogs only say where, and report what Herdr confirmed. New agent is one dialog for every Host kind: the
// chosen Host's kind draws the form (HostKindUi.NewForm), and Pi's form is the default.

import { useEffect, useRef, useState } from "react";
import type { RelaunchCheck, ThreadRelaunched, ThreadSummary } from "../../../src/shared/protocol.ts";
import { findHost, hub, type HostState } from "../client.ts";
import { hostKind } from "../host-kinds.ts";
import { kindUi, type NewFormProps } from "../shell-slots.ts";
import { hostLabel, hostLabelFor } from "./host-label.ts";
import { useFeeds } from "../context.ts";
import { MOD, go } from "../util.ts";
import { freshPress } from "../composer-keys.ts";
import { Modal } from "./Modal.tsx";
import { Segmented } from "./Segmented.tsx";
import { newId } from "../ids.ts";

type Place = "right" | "down" | "workspace";
/** The last New agent choices; every form writes its Host link as `host`, so the dialog reopens on it. */
export const NEW_AGENT_KEY = "ampi.newAgent";

/**
 * New agent: the Host select, then the chosen Host kind's form. A kind that prefers new work (HostKind.preferNew) is
 * the default: from a Session, the same Host's preferred source; without one, the first connected preferred Host.
 * The form keeps its fields across Hosts of one kind; another kind draws a new form.
 */
export function NewAgentDialog({ hosts, defaultHost, beside, onClose }: { hosts: HostState[]; defaultHost?: string; beside?: ThreadSummary; onClose: () => void }) {
	const last = JSON.parse(localStorage.getItem(NEW_AGENT_KEY) ?? "{}") as { host?: string };
	const connected = hosts.filter((h) => h.status === "connected");
	const routed = findHost(hosts, defaultHost);
	const preferred = (h: HostState) => hostKind(h).preferNew === true;
	const twin = routed && !preferred(routed) ? connected.find((h) => h.id === routed.id && preferred(h)) : undefined;
	const fallback = routed ? undefined : connected.find(preferred);
	const [host, setHost] = useState(twin?.link ?? routed?.link ?? fallback?.link ?? findHost(hosts, last.host)?.link ?? connected[0]?.link ?? "");
	const chosen = findHost(hosts, host);
	const Form = kindUi(chosen).NewForm ?? PiNewForm;
	return (
		<Modal onClose={onClose}>
			<h2>New agent</h2>
			<div className="field">
				Host
				<select value={host} onChange={(e) => setHost(e.target.value)} aria-label="Host">
					{hosts.map((h) => (
						<option key={h.link} value={h.link} disabled={h.status !== "connected"}>
							{hostLabel(h, hosts)} {h.status === "connected" ? "" : `— ${h.status}`}
						</option>
					))}
				</select>
			</div>
			<Form key={hostKind(chosen).source} host={host} hosts={hosts} beside={host === routed?.link ? beside : undefined} onClose={onClose} />
		</Modal>
	);
}

/** Where a new Pi agent goes: beside the open Session (its pane, split right or down) or in a new Herdr workspace. */
function PiNewForm({ host, hosts, beside, onClose }: NewFormProps) {
	const last = JSON.parse(localStorage.getItem(NEW_AGENT_KEY) ?? "{}") as { host?: string; place?: string; cwd?: Record<string, string> };
	const besidePane = beside?.location?.pane ? beside : undefined;
	const [chosen, setPlace] = useState<Place>(besidePane ? (last.place === "down" ? "down" : "right") : "workspace");
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
	const [requestId] = useState(() => newId());
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
			localStorage.setItem(NEW_AGENT_KEY, JSON.stringify({ ...last, host, place, cwd: { ...last.cwd, [host]: cwd.trim() } }));
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
		<>
			<div className="field">
				Where
				<Segmented label="Where" value={place} onChange={setPlace} options={[...(besidePane ? [["right", "Beside, right"], ["down", "Beside, below"]] as const : []), ["workspace", "New workspace"]]} />
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
					className="quiet-scroll"
					rows={3}
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					aria-label="First message"
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && freshPress(e.nativeEvent)) void create();
					}}
				/>
			</div>
			{error && <div className="err-box" role="alert">{error} Check the Host and directory, then retry. Your message is kept here.</div>}
			{note && <div className="attn-box" role="status">{note} Open the agent to check its state.</div>}
			<div className="actions">
				<span className="hint" style={{ marginRight: "auto" }}>
					Herdr starts Pi in {where} on {hostLabelFor(host, hosts)}.
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
		</>
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

/**
 * What the owner can do after a relaunch refusal or failure: what is true now, then the next step. A next step must
 * work in the state the failure leaves: after Pi stopped, the pane shows a shell, which AmPi's Close pane no longer
 * recognizes, so the step is Herdr's close and then Resume.
 */
function relaunchErrorText(code: string | undefined, message: string): string {
	const said = sentence(message);
	const shellNext = "When the pane shows a shell, close the pane in Herdr, then Resume.";
	switch (code) {
		case "stop_timeout": return `${said} Its queued messages may be lost. ${shellNext} If Pi still runs, quit it in its pane.`;
		case "stop_pending": return `Pi got the stop signal from an earlier relaunch and has not exited yet. Nothing was sent. ${shellNext}`;
		case "start_refused": return `${said} The pane is at its shell. Close the pane in Herdr, then Resume.`;
		case "outcome_unknown": return `An earlier attempt may have started Pi in the pane. Check the pane. If it shows a shell, close the pane in Herdr, then Resume.`;
		case "binding_changed": case "pane_moved": return "The pane no longer shows this Session. Nothing was stopped. Open the Session from the list to find its pane.";
		case "no_shell": return "Pi is the only process in this pane, so it cannot start again here. Nothing was stopped. Close the pane, then Resume.";
		case "not_pi": return "AmPi cannot find the Pi process in this pane. Nothing was stopped. Check the pane in Herdr: if it shows a shell, close it there, then Resume.";
		case "already_running": return `${said} Open the Session from the list to find the Pi that has it.`;
		case "herdr_outdated": return "The Herdr on this Host has no `pane process-info`. Nothing was stopped. Update Herdr on this Host, then try again.";
		case "control_reloading": return "pi-hc-control in this Pi is reloading. Nothing was stopped. Try again in a few seconds.";
		case "relaunching": return "Pi is already relaunching in this pane. Wait until it is back.";
		case "timeout": return "The Host did not answer in time, so the outcome is unknown. Try again: AmPi continues the same relaunch.";
		case "start_deferred": return "Pi stopped, but too little time was left to start it. Try again: AmPi starts it in the same pane.";
		case "host_slow": return `${said} Nothing was stopped. Try again.`;
		default: return said;
	}
}
/** A message as a sentence: a capital first letter and a full stop. */
const sentence = (message: string) => {
	const text = message.trim();
	const capital = text.charAt(0).toUpperCase() + text.slice(1);
	return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};
const RETRYABLE = new Set(["timeout", "host_unavailable", "start_deferred", "host_slow", "control_reloading"]);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Relaunch stops Pi in its pane and starts it on the same Session there, so configs, extensions, model catalogs and
 * the Pi build load fresh. The dialog asks first only when the relaunch loses something: a turn, queued messages,
 * editor text, launch flags, or an unknown queue (no control); a Team Worker gets a note. One `requestId` per dialog,
 * so Try again continues the same relaunch.
 */
export function RelaunchAgentDialog({ host, summary, onClose }: { host: string; summary: ThreadSummary; onClose: () => void }) {
	const [requestId] = useState(() => newId());
	const [phase, setPhase] = useState<"checking" | "confirm" | "running" | "done" | "error">("checking");
	const [check, setCheck] = useState<RelaunchCheck>();
	const [result, setResult] = useState<Extract<ThreadRelaunched, { pane: string }>>();
	const [error, setError] = useState<{ code?: string; text: string }>();
	const place = [summary.location?.workspaceLabel, summary.location?.tabLabel].filter(Boolean).join(" › ");
	const worker = summary.team?.role === "worker" ? summary.team.worker || summary.title : undefined;
	const busy = check && check.activity !== "idle";
	const force = !!check && (busy || check.queued > 0 || !check.editorEmpty);
	const fail = (e: unknown) => {
		const err = e as Error & { code?: string };
		setError({ code: err.code, text: relaunchErrorText(err.code, err.message) });
		setPhase("error");
	};
	const run = async (withForce: boolean) => {
		setPhase("running");
		setError(undefined);
		try {
			const r = await hub.request(host, "thread.relaunch", { threadId: summary.id, requestId, ...(withForce ? { force: true } : {}) });
			if ("pane" in r) setResult(r);
			setPhase("done");
		} catch (e) {
			// The Session changed since the check: ask again with what is true now.
			const code = (e as { code?: string }).code;
			if (code === "busy" || code === "editor_not_empty") void preflight(true);
			else fail(e);
		}
	};
	const preflight = async (ask = false) => {
		setPhase("checking");
		try {
			const r = await hub.request(host, "thread.relaunch", { threadId: summary.id, requestId: newId(), check: true });
			if (!("check" in r)) throw Object.assign(new Error("The Host did not report the Session's state"), { code: "malformed" });
			setCheck(r.check);
			const lossless = r.check.activity === "idle" && r.check.queued === 0 && r.check.editorEmpty && r.check.control && !r.check.dropped.length;
			if (lossless && !worker && !ask) void run(false);
			else setPhase("confirm");
		} catch (e) {
			fail(e);
		}
	};
	const started = useRef(false);
	useEffect(() => {
		if (started.current) return;
		started.current = true;
		void preflight();
	}, []);
	const returned = result?.returned.length ?? 0;
	return (
		<Modal onClose={onClose}>
			<h2>Relaunch Pi for {summary.title}</h2>
			{phase === "done" && result ? (
				<div role="status">
					{result.evidence === "started"
						? <p>Pi relaunched{place ? ` in ${place}` : ""}. The transcript continues.</p>
						: <p>Herdr started Pi again{place ? ` in ${place}` : ""}, but AmPi has no proof that it runs. Check the pane.</p>}
					{returned > 0 && <p className="hint">{plural(returned, "queued message")} came back to the composer as not sent.</p>}
					{result.warning && <p className="hint">{result.warning}</p>}
				</div>
			) : (
				<>
					<p>Pi exits and starts again in its pane{place ? ` in ${place}` : ""}, on the same Session. Settings, extensions, model catalogs and the Pi build load fresh.</p>
					{phase === "confirm" && check && (
						<ul className="hint">
							{busy && <li>Pi is {check.activity === "compacting" ? "compacting" : check.activity === "blocked" ? "waiting for an answer in its pane" : "running a turn"}. Relaunch stops it first; the partial answer is lost.</li>}
							{check.queued > 0 && <li>{plural(check.queued, "queued message")} come back to AmPi's composer as not sent, with their text.</li>}
							{!check.editorEmpty && <li>The Pi pane's input box has text, or AmPi cannot read it. Relaunch discards it.</li>}
							{!check.control && <li>This Pi has no control socket, so AmPi cannot see its queue.</li>}
							{check.dropped.length > 0 && <li>Pi started with flags a relaunch does not repeat: <code>{check.dropped.join(" ")}</code>. The new Pi gets only the Session.</li>}
							{worker && <li>This Pi is Team Worker {worker}. Its lead sees the exit. The same Session starts again in this pane.</li>}
							{summary.team?.role === "lead" && <li>This is a Pi Team Bright lead. Its Workers keep running in their own panes.</li>}
						</ul>
					)}
					{phase === "error" && error && <div className="err-box" role="alert">{error.text}</div>}
				</>
			)}
			<div className="actions">
				<button className="btn" onClick={onClose}>
					{phase === "done" ? "Done" : phase === "error" && !RETRYABLE.has(error?.code ?? "") ? "Close" : "Cancel"}
				</button>
				{phase === "confirm" && (
					<button className={force ? "btn danger" : "btn primary"} onClick={() => void run(force)}>
						{busy || (check?.queued ?? 0) > 0 ? "Stop and relaunch" : check && !check.editorEmpty ? "Relaunch anyway" : "Relaunch"}
					</button>
				)}
				{(phase === "checking" || phase === "running") && (
					<button className="btn primary" disabled>
						{phase === "checking" ? "Checking…" : "Relaunching…"}
					</button>
				)}
				{phase === "error" && RETRYABLE.has(error?.code ?? "") && (
					<button className="btn primary" onClick={() => void run(force)}>
						Try again
					</button>
				)}
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
	const [requestId] = useState(() => newId());
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
				<Segmented label="Split" value={direction} onChange={setDirection} options={[["right", "Right"], ["down", "Below"]]} />
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
