import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { hudView } from "../hud.ts";
import { useHoverCard } from "./hover-card.tsx";

/** The composer's model label; hover or focus shows the Session's place, usage and model ID in hc-hud's footer style. */
export function ModelHudCard({ summary }: { summary: ThreadSummary }) {
	// The composer sits at the bottom of the window, so the card opens upward.
	const { id, open, anchorProps, render } = useHoverCard<HTMLSpanElement>({ prefer: "above" });
	const view = open ? hudView(summary) : undefined;
	return <span className="model-hud-card" {...anchorProps}>
		<span className="model-hud-trigger hint" tabIndex={0} aria-describedby={open ? id : undefined}>{summary.model}</span>
		{view && render("Session HUD", <>
			<div className="hud-footer">{view.lines.map((line, i) => <div key={i}>{line.map((span, j) => <span key={j} className={span.tone && `hud-${span.tone}`}>{span.text}</span>)}</div>)}</div>
			{view.modelId && <p className="hud-note">Model ID: {view.modelId}</p>}
		</>)}
	</span>;
}
