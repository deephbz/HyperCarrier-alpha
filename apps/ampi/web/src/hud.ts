// A reduced projection of the hc-hud full tier (packages/hc-hud/src/visual-language.mjs) from one ThreadSummary: the
// Session's place, its usage and its full model ID. The transcript header beside the card already names the Session.
import type { ThreadSummary } from "../../src/shared/protocol.ts";

export type HudTone = "dim" | undefined;
export type HudSpan = { text: string; tone?: HudTone };
export type HudView = { lines: HudSpan[][]; modelId?: string };

export const SEPARATOR = " · ";
const ABSENT = "—";
const CYCLE = "⟲";

export const formatTokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

/** hc-hud's displayCwd for the common home layouts; the hub does not know the Host's home directory. */
export const displayCwd = (cwd: string) => cwd.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, "~");

function join(parts: HudSpan[][]): HudSpan[] {
	return parts.flatMap((part, i) => (i ? [{ text: SEPARATOR, tone: "dim" as const }, ...part] : part));
}

export function hudView(s: ThreadSummary): HudView {
	const session: HudSpan[][] = [];
	if (s.cwd) session.push([{ text: displayCwd(s.cwd), tone: "dim" }]);
	// hc-hud hides team.member under a multiplexer; a Session in a Herdr pane runs under one.
	if (s.team && !s.location?.pane) session.push([{ text: s.title === s.team.teamId ? s.team.role : `${s.team.teamId}/${s.team.role}` }]);

	const limit = s.workingBudget ?? s.contextWindow;
	const used = s.contextTokens;
	// Without Auto Compact's context.budget slot, hc-hud shows its dim fallback: percent of the model window.
	const context = used === undefined ? "?" : limit ? `${Math.round(100 * used / limit)}%/${formatTokens(limit)}` : `${formatTokens(used)}/${ABSENT}`;
	// An updating Session has no model, context or cost yet (ThreadSummary.updating).
	const usage: HudSpan[][] = s.updating ? [[{ text: "updating", tone: "dim" }]] : [
		[{ text: `${context} ${CYCLE}${ABSENT}`, tone: "dim" }],
		[{ text: `$${s.costUsd.toFixed(2)}${s.cacheHit !== undefined ? ` CH${Math.floor(s.cacheHit)}%` : ""}`, tone: "dim" }],
	];

	// A Session without a cwd or a Team draws no empty row.
	return { lines: [join(session), join(usage)].filter((line) => line.length), ...(s.model ? { modelId: s.model } : {}) };
}
