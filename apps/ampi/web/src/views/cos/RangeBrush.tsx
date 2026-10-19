import { useRef } from "react";
import { dateTime } from "./data.tsx";
import { brushRange, MIN_SPAN, type BrushMode, type TimeRange } from "./range.ts";

type Drag = { id: number; mode: BrushMode; x: number; anchor: number; initial: TimeRange; last: TimeRange };
export function RangeBrush({ bounds, range, overview, onPreview, onCommit }: {
	bounds: TimeRange; range: TimeRange; overview: string;
	onPreview: (range: TimeRange | undefined) => void; onCommit: (range: TimeRange) => void;
}) {
	const drag = useRef<Drag | undefined>(undefined);
	const track = useRef<HTMLDivElement>(null);
	const [min, max] = bounds;
	const [from, to] = range;
	const percent = (time: number) => Math.max(0, Math.min(100, (time - min) / (max - min) * 100));
	const point = (x: number) => { const box = track.current!.getBoundingClientRect(); return min + Math.max(0, Math.min(1, (x - box.left) / box.width)) * (max - min); };
	return <div className="cos-range">
		<div className="cos-brush" ref={track} role="group" aria-label="Timeline range brush"
			onPointerDown={(e) => {
				if (e.button !== 0 || drag.current) return;
				e.preventDefault();
				const mode = (e.target as HTMLElement).closest<HTMLElement>("[data-brush-mode]")?.dataset.brushMode as BrushMode | undefined;
				const anchor = point(e.clientX);
				const initial: TimeRange = [from, to];
				const span = Math.min(to - from, max - min);
				// A click on empty space centers the current window; a drag selects from its anchor.
				const last = mode ? initial : brushRange("pan", initial, from, anchor - span / 2, bounds);
				drag.current = { id: e.pointerId, mode: mode ?? "select", x: e.clientX, anchor, initial, last };
				track.current!.setPointerCapture(e.pointerId);
				if (mode === "start" || mode === "end") (e.target as HTMLElement).closest<HTMLElement>("[data-brush-mode]")?.focus();
				onPreview(last);
			}}
			onPointerMove={(e) => {
				const current = drag.current;
				if (!current || current.id !== e.pointerId || (current.mode === "select" && Math.abs(e.clientX - current.x) < 3)) return;
				const time = point(e.clientX);
				// Preserve the grab offset inside a handle's hit area.
				const target = current.mode === "start" ? current.initial[0] + time - current.anchor : current.mode === "end" ? current.initial[1] + time - current.anchor : time;
				current.last = brushRange(current.mode, current.initial, current.anchor, target, bounds);
				onPreview(current.last);
			}}
			onPointerUp={(e) => {
				const current = drag.current;
				if (!current || current.id !== e.pointerId) return;
				drag.current = undefined;
				track.current!.releasePointerCapture(e.pointerId);
				onCommit(current.last);
			}}
			onPointerCancel={() => { drag.current = undefined; onPreview(undefined); }}
			onLostPointerCapture={() => { if (drag.current) { drag.current = undefined; onPreview(undefined); } }}>
			<svg viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true"><path d={overview} /></svg>
			<div className="cos-brush-window" data-brush-mode="pan" title="Drag to pan the selected range" style={{ left: `${percent(from)}%`, width: `${percent(to) - percent(from)}%` }}>
				{(["start", "end"] as const).map((edge) => <button key={edge} className={`cos-brush-handle cos-brush-${edge}`} data-brush-mode={edge} type="button" role="slider" aria-label={`Range ${edge}`} aria-valuemin={edge === "start" ? min : from + MIN_SPAN} aria-valuemax={edge === "start" ? to - MIN_SPAN : max} aria-valuenow={edge === "start" ? from : to} aria-valuetext={dateTime(edge === "start" ? from : to)} title={`Drag ${edge}; arrow keys move one minute (Shift: one hour)`}
					onKeyDown={(e) => {
						if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
						e.preventDefault();
						const value = edge === "start" ? from : to;
						const delta = (e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1) * (e.shiftKey ? 3600_000 : MIN_SPAN);
						const target = e.key === "Home" ? min : e.key === "End" ? max : value + delta;
						onCommit(brushRange(edge, range, value, target, bounds));
					}} />)}
			</div>
		</div>
		<div className="cos-brush-caption">Drag to select · Alt + wheel to zoom</div>
	</div>;
}
