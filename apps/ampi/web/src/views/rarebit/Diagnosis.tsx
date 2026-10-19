import type { Kinds, RarebitValue } from "../../../../src/pi/views/rarebit.ts";
import { tokens } from "../../util.ts";

const KINDS: [keyof Kinds, string, string][] = [
	["user", "□ You", "user"], ["continuation", "• Continues", "continuation"], ["stop", "● Stops", "stop"],
	["toolCalls", "Tool calls", "calls"], ["toolResults", "Tool results", "results"], ["thinking", "Thinking", "thinking"], ["summary", "Compaction summary", "summary"], ["other", "Other prose", "other"],
];
const sum = (k: Kinds) => Object.values(k).reduce((a, b) => a + b, 0);
const percent = (n: number, total: number) => total && n / total < 0.01 && n > 0 ? "<1%" : `${total ? Math.round(n / total * 100) : 0}%`;

function Bar({ title, caption, kinds }: { title: string; caption: string; kinds: Kinds }) {
	const total = sum(kinds);
	const values = KINDS.map(([key]) => kinds[key]);
	// 100 cells: one per non-empty kind, the rest allocated by largest remainder.
	const room = 100 - values.filter((v) => v > 0).length;
	const raw = values.map((v) => total ? v / total * room : 0);
	const cells = raw.map((v, i) => values[i]! > 0 ? 1 + Math.floor(v) : 0);
	let left = total ? 100 - cells.reduce((a, b) => a + b, 0) : 0;
	for (const { i } of raw.map((v, i) => ({ i, part: v % 1 })).sort((a, b) => b.part - a.part)) if (left && values[i]! > 0) { cells[i]!++; left--; }
	return <section className="rb-diagnosis-bar">
		<strong>{title}</strong><div className="rb-meta">{caption}</div>
		<div className="rb-bar" role="img" aria-label={`${title}: ${KINDS.filter(([key]) => kinds[key] > 0).map(([key, label]) => `${label} ${percent(kinds[key], total)}`).join(", ") || "no message content"}`}>
			{KINDS.map(([key, label, tone], i) => cells[i]! > 0 && <span key={key} className={`rb-segment rb-color-${tone}`} style={{ width: `${cells[i]}%` }} title={`${label}: ${tokens(kinds[key])} estimated tokens (${percent(kinds[key], total)})`} />)}
		</div>
		{["Rarebit", "Work"].map((family, f) => <div className={`rb-legend ${f === 0 ? "rb-rarebit-legend" : ""}`} key={family}>
			<span>{family} {percent(KINDS.slice(f ? 3 : 0, f ? undefined : 3).reduce((n, [key]) => n + kinds[key], 0), total)}</span>
			{KINDS.slice(f ? 3 : 0, f ? undefined : 3).filter(([key]) => kinds[key] > 0).map(([key, label, tone]) => <span key={key}><i className={`rb-color-${tone}`} />{label} {percent(kinds[key], total)}</span>)}
		</div>)}
	</section>;
}

export function Diagnosis({ value }: { value: RarebitValue }) {
	return <div className="rb-diagnosis">
		<Bar title="Live context" caption={`${tokens(sum(value.diagnosis.live))} est. · messages since last compaction + summary`} kinds={value.diagnosis.live} />
		<Bar title="Whole Session" caption={`${tokens(sum(value.diagnosis.session))} est. · ${value.stats.compactions} compactions · ${value.diagnosis.entries} entries in ${value.diagnosis.ms} ms`} kinds={value.diagnosis.session} />
		<p className="rb-meta">ceil(characters ÷ 4) per kind; not model usage. Setup, reserved buffer, and capacity are unavailable.</p>
	</div>;
}
