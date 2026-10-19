// The Arc panel beside a Pi Session: the same tier-2 tree as the Arc page (ArcTree.tsx), read from the saved receipt.
// Opening it never calls a model; only Build does.

import { useEffect, useState } from "react";
import type { ArcValue } from "../../../../src/pi/views/cos-arc.ts";
import { hub, useTopic } from "../../client.ts";
import { href } from "../../util.ts";
import { ArcContextView } from "./ArcTree.tsx";
import { estimateText, failureHint, failurePrefix, progressText } from "./builds.ts";
import type { ViewError } from "./data.tsx";
import "./cos.css";

/** The owner's last Arc panel choice in this browser; "open" reopens it on the next wide Session. */
export const PANEL_DEFAULT_KEY = "ampi.panel.default";
const PREF = PANEL_DEFAULT_KEY;
/** Below this pane width (sidebar excluded) the panel starts collapsed, whatever was saved. */
export const ARC_PANEL_MIN_PANE = 900;

export type ArcBuild = { pending: boolean; failure: string; start: () => void };

export function useArcBuild(host: string, threadId: string): ArcBuild {
	const [failure, setFailure] = useState("");
	const [pending, setPending] = useState(false);
	const start = async () => {
		setFailure(""); setPending(true);
		try { await hub.request(host, "view.cos-arc.build", { threadId }); }
		catch (e) { setFailure((e as Error).message); }
		finally { setPending(false); }
	};
	return { pending, failure, start: () => void start() };
}

/** Pure view of the panel, so tests render it without a hub connection. */
export function ArcPanelView({ host, threadId, value: v, error, notice, build }: { host: string; threadId: string; value?: ArcValue; error?: string; notice?: string; build: ArcBuild }) {
	const running = build.pending || v?.job?.state === "running";
	const refresh = v && (!v.context || v.contextStatus.newMessages > 0 || v.contextStatus.branchChanged);
	return <div className="cos-arc-panel" data-panel="arc">
		<div className="cos-arc-panel-head">
			<a href={href.page("arcs", [host, threadId])}>Full Arc page</a>
			<span className="spacer" />
			{refresh && <button className="btn small" disabled={running || !v.chunks.length} onClick={build.start} title="Input estimate uses characters ÷ 4; output tokens and price depend on the hub’s model.">{running ? "Building arc…" : "Build arc"}</button>}
		</div>
		{refresh && !running && <p className="cos-caption">Build estimate: {estimateText(v.buildEstimate)}.</p>}
		{v?.job?.state === "running" && <p className="cos-notice" role="status">{progressText(v.job)}</p>}
		{(build.failure || v?.job?.lastError) && <p className="cos-error" role="alert">{failurePrefix(build.failure ? undefined : v?.job?.lastError?.code)} {build.failure || v?.job?.lastError?.message} {failureHint(build.failure ? undefined : v?.job?.lastError?.code)}</p>}
		{v ? <ArcContextView value={v} /> : <p className="cos-meta" role="status">{error ? `${error}. Reconnect the Host, then reopen this panel.` : notice ?? "Reading the saved Arc…"}</p>}
	</div>;
}

export function ArcPanel({ host, threadId }: { host: string; threadId: string }) {
	const { value, error } = useTopic<ArcValue | { missing: true; notice: string } | ViewError>(host, { kind: "view", view: "cos.arc", threadId });
	const build = useArcBuild(host, threadId);
	const v = value && !("missing" in value) && !("error" in value) ? value : undefined;
	const failure = value && "error" in value ? value.error.message : error;
	return <ArcPanelView host={host} threadId={threadId} value={v} error={failure} notice={value && "notice" in value ? value.notice : undefined} build={build} />;
}

/** The pane beside the sidebar: the transcript plus any open panel. It uses the owner's saved sidebar (App.tsx keys),
 * because an open panel can squeeze the sidebar away and the live DOM would then overstate the pane. */
function paneWidth(): number {
	const sidebar = localStorage.getItem("ampi.sidebar.hidden") === "1" ? 0 : Number(localStorage.getItem("ampi.sidebar.width")) || 280;
	return window.innerWidth - sidebar;
}

export function toggleArcPanel(panel: string | undefined, setPanel: (p?: string) => void, closeAny = false) {
	if (closeAny && panel) { setPanel(undefined); return; }
	if (closeAny) { setPanel(localStorage.getItem(PANEL_DEFAULT_KEY) || "arc"); return; }
	const open = panel === "arc";
	if (!open) localStorage.setItem(PANEL_DEFAULT_KEY, "arc");
	setPanel(open ? undefined : "arc");
}

/** The Session header's Arc button. It keeps focus and scroll where they are (I20): no focus steal, no hash change. */
export function ArcToggle({ panel, setPanel }: { panel?: string; setPanel: (p?: string) => void }) {
	useEffect(() => {
		// Move the former open/closed preference to the single panel-default preference.
		const legacy = localStorage.getItem("ampi.arc.panel");
		if (!localStorage.getItem(PREF) && legacy === "open") localStorage.setItem(PREF, "arc");
		localStorage.removeItem("ampi.arc.panel");
		// Runs once per Session open: a narrow pane starts collapsed even when "arc" was saved; a wide one restores it.
		const wide = paneWidth() >= ARC_PANEL_MIN_PANE;
		if (!wide && panel === "arc") setPanel(undefined);
		else if (wide && !panel && localStorage.getItem(PREF) === "arc") setPanel("arc");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const open = panel === "arc";
	const toggle = () => toggleArcPanel(panel, setPanel);
	return <button className="btn ghost small" aria-pressed={open} title={open ? "Hide the Arc panel" : "Show this Session’s Arc: Needs you and the Work tree"} onMouseDown={(e) => e.preventDefault()} onClick={toggle}>Arc</button>;
}
