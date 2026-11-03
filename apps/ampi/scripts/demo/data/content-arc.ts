import type { ArcAnswer, Claim } from "../../../src/shared/arc.ts";
type DemoDataMode = "demo" | "worst" | "empty" | "one" | "huge";

const cite = (id: string, quote: string): Claim => ({ text: quote, cites: [{ id, quote }] });

/** Typed Arc model-answer data for the demo hub's content fixture. */
export function contentArcSeed(mode: DemoDataMode): ArcAnswer | undefined {
	if (mode === "demo" || mode === "empty" || mode === "huge") return undefined;
	if (mode === "one") {
		const id = "content-one-1";
		return {
			goal: cite(id, "Read one synthetic content Session."),
			now: cite(id, "The one-message fixture is ready to inspect."),
			chapters: [{ firstId: id, label: "One message", closed: false, summary: { scope: cite(id, "One synthetic message."), bullets: [] } }],
			points: [],
		};
	}
	const first = "content-worst-1";
	const multilingual = "content-worst-4";
	const last = "content-worst-225";
	const longLabel = "Đặng Thị Ngọc Hân 王秀英 نور الهدى عبد الرحمن 🦊 Fox 👩🏽‍💻";
	return {
		goal: cite(first, "Inspect multilingual text"),
		now: cite(last, "result 220"),
		chapters: [
			{ firstId: first, label: longLabel, closed: true, summary: { scope: cite(first, "Inspect multilingual text"), bullets: [{ ...cite(multilingual, "Synthetic tool failure"), children: [{ ...cite(last, "result 220") }] }] } },
			{ firstId: multilingual, label: "Review the long tool output and wide code sample", closed: false, summary: { scope: cite(multilingual, "Synthetic tool failure"), bullets: [{ ...cite(multilingual, "Synthetic tool failure") }] } },
		],
		points: [{ kind: "request", state: "open", by: "agent", waits: "owner", title: longLabel, text: "Inspect the full multilingual result and its clipped boundary.", cites: [{ id: multilingual, quote: "Synthetic tool failure" }] }],
	};
}
