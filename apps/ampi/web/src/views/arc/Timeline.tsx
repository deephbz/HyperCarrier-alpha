import { useLayoutEffect, useRef, useState } from "react";
import { hoverIntent } from "../../components/Popover.tsx";
import type { Chapter, UsageSeries } from "../../../../src/shared/protocol.ts";

const WIDTH = 1000, HEIGHT = 96;
export function ChapterTimeline({ chapters, series, unit, hover, flash, onHover, onOpen }: {
	chapters: Chapter[]; series?: UsageSeries; unit: 1 | 2; hover?: number; flash?: { n: number; key: number };
	onHover: (n?: number) => void; onOpen: (n: number) => void;
}) {
	const svg = useRef<SVGSVGElement>(null), tickLabels = useRef<HTMLDivElement>(null);
	const [pixels, setPixels] = useState(300);
	const [hiddenTicks, setHiddenTicks] = useState<Set<number>>(() => new Set());
	useLayoutEffect(() => {
		const element = svg.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setPixels(element.getBoundingClientRect().width));
		observer.observe(element);
		setPixels(element.getBoundingClientRect().width);
		return () => observer.disconnect();
	}, [chapters.length]);
	useLayoutEffect(() => {
		const container = tickLabels.current;
		if (!container) return;
		const bounds = container.getBoundingClientRect(), hidden = new Set<number>();
		let right = bounds.left - 4;
		[...container.children].forEach((label, i) => {
			const rect = label.getBoundingClientRect();
			if (rect.left < right + 4 || rect.right > bounds.right + .5) hidden.add(i);
			else right = rect.right;
		});
		setHiddenTicks(old => old.size === hidden.size && [...old].every(i => hidden.has(i)) ? old : hidden);
	}, [pixels, chapters, series]);
	if (!chapters.length) return null;
	const times = chapters.map(c => ({ from: c.firstAt === null ? NaN : Date.parse(c.firstAt), to: c.lastAt === null ? NaN : Date.parse(c.lastAt) }));
	const timed = times.every(t => Number.isFinite(t.from) && Number.isFinite(t.to));
	const from = timed ? times[0]!.from : 0;
	const to = timed ? Math.max(from + 1, times.at(-1)!.to, (series?.buckets.at(-1)?.[0] ?? from) + (series?.bucketMs ?? 0)) : chapters.length;
	const spans = times.map((t, i) => timed ? { from: t.from, to: times[i + 1]?.from ?? to } : { from: i, to: i + 1 });
	const minimum = Math.min(WIDTH / chapters.length, 8 / Math.max(1, pixels) * WIDTH);
	let remaining = WIDTH, duration = to - from;
	const widths = spans.map(() => 0);
	let pending = spans.map((_, i) => i);
	// Fix undersized bands first, then shrink the remaining neighbours proportionally.
	while (pending.length) {
		const small = pending.filter((i) => (spans[i]!.to - spans[i]!.from) / duration * remaining < minimum);
		if (!small.length) { for (const i of pending) widths[i] = duration > 0 ? (spans[i]!.to - spans[i]!.from) / duration * remaining : remaining / pending.length; break; }
		for (const i of small) { widths[i] = minimum; remaining -= minimum; duration -= spans[i]!.to - spans[i]!.from; }
		pending = pending.filter((i) => !small.includes(i));
	}
	const offsets = widths.map((_, i) => widths.slice(0, i).reduce((sum, width) => sum + width, 0));
	const x = (at: number) => {
		if (at <= from) return 0;
		if (at >= to) return WIDTH;
		const i = spans.findIndex((s) => at < s.to);
		return offsets[i]! + (at - spans[i]!.from) / Math.max(1, spans[i]!.to - spans[i]!.from) * widths[i]!;
	};
	const peak = Math.max(0, ...series?.buckets.map((b) => b[unit]) ?? []) || 1;
	const stream = timed ? series?.buckets.map((b) => {
		const h = Math.max(0, b[unit]) / peak * 34;
		return `M${x(b[0])},${52 - h}H${x(b[0] + series.bucketMs)}V${52 + h}H${x(b[0])}Z`;
	}).join(" ") : undefined;
	const ticks: number[] = [];
	const d = new Date(from); d.setMinutes(0, 0, 0); d.setHours(Math.ceil(d.getHours() / 6) * 6);
	if (d.getTime() < from) d.setHours(d.getHours() + 6);
	while (timed && d.getTime() <= to) { ticks.push(d.getTime()); d.setHours(d.getHours() + 6); }
	return <div className="arc-timeline">
		<div className="arc-timeline-grid">
			<div className="arc-gutter"><span>Chapter</span><span>{timed ? <>{unit === 1 ? "Tokens" : "$"}<br />/ 15 min</> : "Time unavailable"}</span></div>
			<svg ref={svg} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-label="Chapter usage timeline">
				{chapters.map((c, i) => <g key={c.n}>
					<rect data-band={c.n} className={`arc-band ${i % 2 ? "alt" : ""} ${hover === c.n ? "hover" : ""}`} x={offsets[i]} y={0} width={widths[i]} height={HEIGHT} role="button" tabIndex={0} aria-label={`Open chapter ${c.n}: ${c.label}`} {...hoverIntent(() => onHover(c.n))} onMouseLeave={() => onHover(undefined)} onFocus={() => onHover(c.n)} onBlur={() => onHover(undefined)} onClick={() => onOpen(c.n)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(c.n); } }} />
					{flash?.n === c.n && <rect key={flash.key} className="arc-band-flash" x={offsets[i]} width={widths[i]} height={HEIGHT} />}
				</g>)}
				{ticks.map((t, i) => !hiddenTicks.has(i) && <line key={t} className={`arc-tick ${new Date(t).getHours() === 0 ? "day" : ""}`} x1={x(t)} x2={x(t)} y1={0} y2={HEIGHT} />)}
				<path className="arc-stream" d={stream} />
			</svg>
			<div className="arc-chapter-numbers" aria-hidden="true">{chapters.map((c, i) => widths[i]! / WIDTH * pixels >= 14 && <span key={c.n} data-number={c.n} className={hover === c.n ? "hover" : ""} style={{ left: `${(offsets[i]! + widths[i]! / 2) / WIDTH * 100}%` }}>{c.n}</span>)}</div>
			<span className="arc-time-label">{timed ? "Time" : "Order"}</span>
			<div ref={tickLabels} className="arc-time-ticks">{ticks.map((t, i) => <span key={t} className={new Date(t).getHours() === 0 ? "day" : ""} style={{ left: `${x(t) / WIDTH * 100}%`, visibility: hiddenTicks.has(i) ? "hidden" : "visible" }}>{new Date(t).toLocaleTimeString("en-US", { hour: "numeric", hour12: true })}{new Date(t).getHours() === 0 && <><br />{new Date(t).toLocaleDateString([], { month: "short", day: "numeric" })}</>}</span>)}</div>
		</div>
		<p className="arc-hint">{!timed ? "Chapter times unavailable. Bands show chapter order. Click a band to open its chapter." : hover !== undefined ? `Chapter ${hover} · ${chapters.find(c => c.n === hover)?.label ?? ""}. Click to open.` : series ? "Hover to locate a chapter. Click a band to open it." : "Usage unavailable. Click a band to open its chapter."}</p>
	</div>;
}
