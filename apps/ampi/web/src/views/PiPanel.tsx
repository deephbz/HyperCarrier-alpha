// The side panel beside a Pi Session: one tab per registered panel view (views/registry.ts).

import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { PI_PANELS } from "./registry.ts";
import { PANEL_DEFAULT_KEY } from "./cos/ArcPanel.tsx";

export function piPanels(summary: ThreadSummary | undefined) {
	return PI_PANELS.filter((p) => !p.available || p.available(summary));
}

export function PiPanel({ name, host, threadId, summary, entry, setPanel }: { name: string; host: string; threadId: string; summary?: ThreadSummary; entry?: string; setPanel: (p?: string) => void }) {
	const tabs = piPanels(summary);
	const view = tabs.find((p) => p.name === name);
	if (!view) return null;
	const View = view.component;
	return (
		<aside className="panel" data-panel-name={name}>
			<div className="panel-tabs">
				<div className="seg">
					{tabs.map((p) => (
						<span key={p.name} className="panel-tab-choice">
							<button className={p.name === name ? "on" : ""} onClick={() => setPanel(p.name)}>{p.label}</button>
							<button className="btn ghost small" aria-label={`Open ${p.label} by default`} title={localStorage.getItem(PANEL_DEFAULT_KEY) === p.name ? "Default panel" : `Open ${p.label} by default`} onClick={() => localStorage.setItem(PANEL_DEFAULT_KEY, p.name)}>{localStorage.getItem(PANEL_DEFAULT_KEY) === p.name ? "★" : "☆"}</button>
						</span>
					))}
				</div>
				<span style={{ flex: 1 }} />
				<button className="btn ghost small" onClick={() => setPanel(undefined)} title="Close panel">
					✕
				</button>
			</div>
			<div className="panel-body">
				<View key={`${host}|${threadId}`} host={host} threadId={threadId} summary={summary} entry={entry} />
			</div>
		</aside>
	);
}
