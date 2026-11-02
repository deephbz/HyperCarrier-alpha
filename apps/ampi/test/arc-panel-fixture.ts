import type { ArcValue, Chapter, Claim, Point } from "../src/shared/protocol.ts";

/** Synthetic receipt: uneven chapter durations, nested evidence, every point kind and Needs-you group. */
export function arcPanelFixture(chapterCount = 15): ArcValue {
	const start = Date.parse("2026-10-20T00:00:00Z");
	const at = (hours: number) => new Date(start + hours * 3600_000).toISOString();
	const claim = (text: string, id: string): Claim => ({ text, cites: [{ id, quote: `Evidence for ${id}.` }] });
	const chapters: Chapter[] = Array.from({ length: chapterCount }, (_, i) => ({
		n: i + 1, firstId: `entry-${i + 1}`, lastId: `reply-${i + 1}`, firstAt: at(i === 1 ? 0.001 : i * 3), lastAt: at((i + 1) * 3 - .01),
		label: i === chapterCount - 1 ? "Checking the final reader" : ["Defined the reader scope", "Fixed the empty view", "Measured the source reader"][i % 3]!, closed: i !== chapterCount - 1,
		tokens: 1200 + i * 13017, cost: .15 + i * .41,
		summary: { scope: claim(`Chapter ${i + 1} checks the reader against the agreed scope.`, `entry-${i + 1}`), bullets: [
			{ ...claim("The reader keeps source messages available.", `reply-${i + 1}`), children: [claim("The empty view gives the next action.", `reply-${i + 1}`)] },
			claim("The checks cover narrow screens and reconnects.", `reply-${i + 1}`),
		] },
	}));
	chapters[0]!.lastAt = at(.0009);
	const kinds = ["request", "decision", "rule", "confusion"] as const;
	const points: Point[] = Array.from({ length: 60 }, (_, i) => {
		const kind = kinds[i % 4]!;
		const state = kind === "request" ? i === 0 ? "blocked" : i === 4 ? "open" : "done" : kind === "decision" ? i === 1 ? "confirm" : "accepted" : kind === "rule" ? "in force" : "resolved";
		return { id: `K${i + 1}`, kind, state, by: i % 2 ? "agent" : "owner", waits: "owner", title: kind === "rule" ? "Keep source messages" : kind === "decision" ? "Agent chose the smaller layout" : kind === "confusion" ? "You asked about blank rows" : "Check the reader result", ...claim(`Point ${i + 1} keeps the source evidence available.`, `entry-${i % 15 + 1}`), chapter: i % 15 + 1, firstAt: at(i / 2), stateAt: at(i / 2 + .1), needsYou: [0, 1, 4].includes(i) };
	});
	return {
		sourceCount: 123, stale: 3, branchChanged: false, status: { state: "idle" },
		receipt: { v: 1, session: "devbox/pi:arc-demo", asOf: "reply-15", asOfCount: 120, fingerprint: "synthetic", builtAt: at(45), model: "demo/fixture", promptVersion: "fixture", tier: "b", selector: "fixture", goal: claim("Make the Session reader easy to inspect on a phone.", "entry-1"), now: claim("The reader works. You can check the layout before release.", "reply-15"), chapters, points, nextPointId: 61, kept: ["K2"], builds: [{ trigger: "stop", startedAt: at(44.9), endedAt: at(45), state: "done", calls: 1, windows: 1, model: "demo/fixture", usage: { input: 1000, output: 400, cacheRead: 0, cacheWrite: 0, cost: .01 }, repairs: [] }] },
		series: { bucketMs: 900_000, start, end: start + chapterCount * 3 * 3600_000, priced: true, buckets: Array.from({ length: chapterCount * 12 }, (_, i) => [start + i * 900_000, (i * 137) % 5000, ((i * 17) % 100) / 1000]) },
	};
}
