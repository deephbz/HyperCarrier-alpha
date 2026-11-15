// The side panel beside a Session: one tab per registered panel view (views/registry.ts), then the panels of its Host
// kind (ThreadSurface.panels).

import { useState } from "react";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { PI_PANELS, type PanelView } from "./registry.ts";
import { PANEL_DEFAULT_KEY } from "./panel-preference.ts";

export function piPanels(summary: ThreadSummary | undefined, extra: readonly PanelView[] = []) {
	return [...PI_PANELS, ...extra].filter((p) => !p.available || p.available(summary));
}

export function PiPanel({ name, host, threadId, summary, entry, extra, setPanel }: { name: string; host: string; threadId: string; summary?: ThreadSummary; entry?: string; extra?: readonly PanelView[]; setPanel: (p?: string) => void }) {
	// ★ marks the ⌘L default; state makes a click show at once (focus R17).
	const [preferred, setPreferred] = useState(() => localStorage.getItem(PANEL_DEFAULT_KEY));
	const tabs = piPanels(summary, extra);
	const view = tabs.find((p) => p.name === name);
	if (!view) return null;
	const View = view.component;
	return (
		<aside className={`panel ${view.wide ? "wide" : ""}`} data-panel-name={name}>
			<div className="panel-tabs">
				<div className="seg quiet-scroll">
					{tabs.map((p) => (
						<span key={p.name} className="panel-tab-choice">
							<button className={p.name === name ? "on" : ""} onClick={() => setPanel(p.name)}>{p.label}</button>
							<button className="btn ghost small" aria-label={`Open ${p.label} by default`} aria-pressed={preferred === p.name} title={preferred === p.name ? "Default panel" : `Open ${p.label} by default`} onClick={() => { localStorage.setItem(PANEL_DEFAULT_KEY, p.name); setPreferred(p.name); }}>{preferred === p.name ? "★" : "☆"}</button>
						</span>
					))}
				</div>
				<span style={{ flex: 1 }} />
				<button className="btn ghost small panel-close" onClick={() => setPanel(undefined)} title="Close panel" aria-label="Close panel">
					✕
				</button>
			</div>
			<div className="panel-body quiet-scroll">
				<View key={`${host}|${threadId}`} host={host} threadId={threadId} summary={summary} entry={entry} />
			</div>
		</aside>
	);
}
