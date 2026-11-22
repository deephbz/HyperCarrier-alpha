import { type CSSProperties, useEffect, useState } from "react";
import { toolElapsedTone } from "./tool-elapsed.ts";

/** Leaf 1 Hz elapsed readout; mounts only while a tool call is running so parent transcript rows do not re-render. */
export function ToolElapsed({ startedAt, now }: { startedAt: number; now?: number }) {
	const [ticked, setTicked] = useState(Date.now);
	useEffect(() => {
		if (now !== undefined) return;
		setTicked(Date.now());
		const timer = setInterval(() => setTicked(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [now]);
	const { text, pct } = toolElapsedTone((now ?? ticked) - startedAt);
	return (
		<span
			className={pct === null ? "tool-elapsed" : "tool-elapsed warn"}
			style={pct === null ? undefined : ({ "--elapsed-pct": `${pct}%` } as CSSProperties)}
		>
			{text}
		</span>
	);
}
