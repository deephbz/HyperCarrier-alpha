import { useEffect, useRef } from "react";
import { modelLabel } from "../model-label.ts";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { hudView } from "../hud.ts";
import { useHoverCard } from "./hover-card.tsx";

/** The composer's model label; hover or focus shows the Session's place, usage and model ID in hc-hud's footer style. */
export function ModelHudCard({ summary, thinking, thinkingLevels, onOpen }: { summary?: ThreadSummary; thinking?: string; thinkingLevels?: string[]; onOpen?: () => void }) {
	// The composer sits at the bottom of the window, so the card opens upward.
	const { id, open, setOpen, anchorProps, render } = useHoverCard<HTMLSpanElement>({ prefer: "above" });
	const fresh = useRef(onOpen);
	fresh.current = onOpen;
	useEffect(() => { if (open) fresh.current?.(); }, [open]);
	const view = open && summary ? hudView(summary) : undefined;
	return <span className="model-hud-card" {...anchorProps}>
		<button type="button" tabIndex={0} className="model-hud-trigger hint" aria-label="Model details" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(true)}>{summary?.model ? modelLabel(summary.model, thinking, thinkingLevels) : "Model"}</button>
		{view && render("Session HUD", <>
			<div className="hud-footer">{view.lines.map((line, i) => <div key={i}>{line.map((span, j) => <span key={j} className={span.tone && `hud-${span.tone}`}>{span.text}</span>)}</div>)}</div>
			{view.modelId && <p className="hud-note">Model ID: {view.modelId}</p>}
		</>)}
	</span>;
}
