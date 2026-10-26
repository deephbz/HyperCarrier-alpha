// The Arc panel beside a Pi Session: the same tier-2 tree as the Arc page (ArcTree.tsx), read from the saved receipt.
// Opening it never calls a model; only Build does.

import { useState } from "react";
import type { ArcFailure, ArcValue } from "../../../../src/pi/views/cos-arc.ts";
import { hub, useTopic } from "../../client.ts";
import { href } from "../../util.ts";
import { ArcContextView } from "./ArcTree.tsx";
import { buildDetail, buildText, estimateText, failureHint, failurePrefix, failureText, labelRetry, lastFailure, MODEL_KEYS, progressText, stuckText } from "./builds.ts";
import type { ViewError } from "./data.tsx";
import "./cos.css";
import { rememberArcShown } from "./arc-reopen.ts";

/** A failed model check's full list of the models Pi lists, one click away; the alert itself names the first few. */
export function AvailableModels({ failure }: { failure: ArcFailure }) {
	const rows = failure.available;
	if (!rows?.length) return null;
	return <details className="cos-models"><summary>All {rows.length} models Pi lists</summary><ul className="quiet-scroll">{rows.map((m) => <li key={m}><code>{m}</code></li>)}</ul></details>;
}

export type ArcBuild = { pending: boolean; failure: string; start: () => void };

export function useArcBuild(host: string, threadId: string): ArcBuild {
	const [failure, setFailure] = useState("");
	const [pending, setPending] = useState(false);
	const start = async () => {
		setFailure(""); setPending(true);
		try { await hub.request(host, "view.cos.arc.build", { threadId }); }
		catch (e) { setFailure((e as Error).message); }
		finally { setPending(false); }
	};
	return { pending, failure, start: () => void start() };
}

/** Pure view of the panel, so tests render it without a hub connection. */
export function ArcPanelView({ host, threadId, value: v, error, notice, build }: { host: string; threadId: string; value?: ArcValue; error?: string; notice?: string; build: ArcBuild }) {
	const running = build.pending || v?.job?.state === "running";
	const failed = v ? lastFailure(v) : null;
	// A failed last Build keeps the button: the shown Arc may be current, but the owner asked for a newer one.
	const refresh = v && (!v.context || v.contextStatus.newMessages > 0 || v.contextStatus.branchChanged || Boolean(failed));
	return <div className="cos-arc-panel" data-panel="arc">
		<div className="cos-arc-panel-head">
			<a href={href.page("arcs", [host, threadId])}>Full Arc page</a>
			<span className="spacer" />
			{refresh && <button className="btn small" disabled={running || !v.chunks.length} onClick={build.start} title={`Input estimate uses characters ÷ 4; output tokens and price depend on the hub’s models. ${MODEL_KEYS}`}>{running ? "Building arc…" : "Build arc"}</button>}
		</div>
		{refresh && !running && <p className="cos-caption">Build estimate: {estimateText(v.buildEstimate)}.</p>}
		{v?.builds?.length ? <p className="cos-meta cos-arc-last-build" title={buildDetail(v.builds.at(-1)!)}>Last Build · {buildText(v.builds.at(-1)!)}</p> : null}
		{v?.job?.state === "running" && <p className="cos-notice" role="status">{progressText(v.job)}</p>}
		{build.failure ? <p className="cos-error" role="alert">{failurePrefix(undefined)} {build.failure} {failureHint(undefined)}</p>
			: failed && <><p className="cos-error" role={failed.role}>{failureText(failed.failure, v!.keptAt, labelRetry(failed.failure, v!))}</p><AvailableModels failure={failed.failure} /></>}
		{v && stuckText(v) && <p className="cos-notice" role="status">{stuckText(v)}</p>}
		{v ? <ArcContextView value={v} /> : <p className="cos-meta" role="status">{error ? `${error}. Reconnect the Host, then reopen this panel.` : notice ?? "Reading the saved Arc…"}</p>}
	</div>;
}

export function ArcPanel({ host, threadId }: { host: string; threadId: string }) {
	const { value, error } = useTopic(host, { kind: "view", view: "cos.arc", threadId });
	const build = useArcBuild(host, threadId);
	const v = value && !("missing" in value) && !("error" in value) && !("sessions" in value) ? value : undefined;
	const failure = value && "error" in value ? value.error.message : error;
	return <ArcPanelView host={host} threadId={threadId} value={v} error={failure} notice={value && "notice" in value ? value.notice : undefined} build={build} />;
}

/** The Arc button: show or hide Arc now. It never writes the ⌘L default. */
export function toggleArcPanel(panel: string | undefined, setPanel: (p?: string) => void) {
	const open = panel === "arc";
	rememberArcShown(!open);
	setPanel(open ? undefined : "arc");
}
