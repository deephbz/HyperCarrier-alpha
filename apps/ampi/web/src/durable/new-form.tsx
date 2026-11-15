// The durable node's New agent form (HostKindUi.NewForm): the thread opens beside the open thread in its tab, or in
// a new tab, with one of the node's models.

import { useEffect, useRef, useState } from "react";
import { hub } from "../client.ts";
import { MOD, go } from "../util.ts";
import { freshPress } from "../composer-keys.ts";
import { hostLabelFor } from "../components/host-label.ts";
import { NEW_AGENT_KEY } from "../components/PiDialogs.tsx";
import { Segmented } from "../components/Segmented.tsx";
import { newId } from "../ids.ts";
import type { ModelChoice } from "../models.ts";
import type { NewFormProps } from "../shell-slots.ts";

type Place = "beside" | "new";

export function DurableNewForm({ host, hosts, beside, onClose }: NewFormProps) {
	const last = JSON.parse(localStorage.getItem(NEW_AGENT_KEY) ?? "{}") as { host?: string; place?: string; cwd?: Record<string, string>; model?: Record<string, string> };
	// Beside needs the open thread in a tab on this node.
	const besideHere = beside?.location?.workspace && !beside.closed ? beside : undefined;
	const [chosen, setPlace] = useState<Place>();
	// The node remembers the last choice. Without the open thread on this source there is nothing to sit beside.
	const pick = chosen ?? last.place;
	const place: Place = !besideHere || pick === "new" ? "new" : "beside";
	const [cwd, setCwd] = useState(besideHere?.cwd ?? last.cwd?.[host] ?? "");
	const [dirs, setDirs] = useState<{ path: string; parent: string; dirs: string[] }>();
	const [models, setModels] = useState<ModelChoice[]>([]);
	const [model, setModel] = useState(last.model?.[host] ?? "");
	const [label, setLabel] = useState("");
	const [prompt, setPrompt] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string>();
	const [started, setStarted] = useState<string>();
	// One ID per dialog: a double submit or a retry after a lost response must not start a second agent.
	const [requestId] = useState(() => newId());
	const first = useRef(true);
	useEffect(() => {
		if (!first.current) {
			setCwd(last.cwd?.[host] ?? "");
			setModel(last.model?.[host] ?? "");
		}
		first.current = false;
		hub.request(host, "models.list").then(setModels, () => setModels([]));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [host]);
	useEffect(() => {
		const timer = setTimeout(() => {
			hub.request(host, "fs.dirs", { path: cwd }).then(setDirs, () => setDirs(undefined));
		}, 150);
		return () => clearTimeout(timer);
	}, [host, cwd]);
	const where = place === "beside" ? `${besideHere?.title ?? "this thread"}'s tab, after it` : "a new tab";
	const create = async () => {
		const dir = (dirs?.path ?? cwd).trim();
		setBusy(true);
		setError(undefined);
		try {
			const [provider, ...id] = model.split("/");
			const placement = place === "new" ? { workspace: "new" as const, ...(label.trim() ? { label: label.trim() } : {}) } : { beside: besideHere!.id };
			const res = (await hub.request(host, "thread.create", {
				cwd: dir,
				place: placement,
				...(model ? { model: { provider, modelId: id.join("/") } } : {}),
				...(prompt.trim() ? { prompt: prompt.trim() } : {}),
				requestId,
			} as never)) as { threadId: string; evidence?: string; pane?: string; submitted?: { error?: { message: string } } };
			localStorage.setItem(NEW_AGENT_KEY, JSON.stringify({ host, place, cwd: { ...last.cwd, [host]: dir }, model: { ...last.model, [host]: model } }));
			const problems = [res.submitted?.error ? `The first message was not sent: ${res.submitted.error.message}` : ""].filter(Boolean);
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
				<Segmented label="Where" value={place} onChange={setPlace} options={[...(besideHere ? [["beside", "Beside this thread, in its tab"]] as const : []), ["new", "New tab"] as const]} />
			</div>
			<div className="field">
				Working directory
				<input value={cwd} placeholder={dirs?.path ?? "~"} onChange={(e) => setCwd(e.target.value)} aria-label="Working directory" />
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
			{place === "new" && (
				<div className="field">
					Tab label (optional)
					<input value={label} placeholder="the directory's name" onChange={(e) => setLabel(e.target.value)} aria-label="Tab label" />
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
					The durable node on {hostLabelFor(host, hosts)} opens the thread in {where}.
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
