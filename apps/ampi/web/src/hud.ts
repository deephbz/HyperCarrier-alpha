// The hc-hud full tier (packages/hc-hud/src/visual-language.mjs), projected from one ThreadSummary. The HUD reads
// Pi's runtime and producer slots inside the Session; the hub reads only the copied Session file, so values it
// cannot see are listed as gaps instead of guessed.
import type { ThreadSummary } from "../../src/shared/protocol.ts";

export type HudTone = "dim" | undefined;
export type HudSpan = { text: string; tone?: HudTone; bold?: boolean };
export type HudView = { lines: HudSpan[][]; modelId?: string; gaps: string[] };

export const SEPARATOR = " · ";
const ABSENT = "—";
const CYCLE = "⟲";

const base = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
export const formatTokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

/** hc-hud's alias rule without configured aliases: `anthropic/claude-fable-5-1` reads `anthropic/fable5.1`. */
export function aliasName(model: string | undefined): string {
	if (!model) return "no-model";
	const slash = model.indexOf("/");
	const provider = slash < 0 ? "" : model.slice(0, slash);
	const id = base(slash < 0 ? model : model.slice(slash + 1)).replace(/^claude-/, "").replace(/-(\d+(?:-\d+)*)$/, (_, digits: string) => digits.replaceAll("-", "."));
	return provider ? `${provider}/${id}` : id;
}

/** hc-hud's displayCwd for the common home layouts; the hub does not know the Host's home directory. */
export const displayCwd = (cwd: string) => cwd.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, "~");

function join(parts: HudSpan[][]): HudSpan[] {
	return parts.flatMap((part, i) => (i ? [{ text: SEPARATOR, tone: "dim" as const }, ...part] : part));
}

export function hudView(s: ThreadSummary): HudView {
	const session: HudSpan[][] = [];
	if (s.title) session.push([{ text: s.title, bold: true }]);
	if (s.cwd) session.push([{ text: displayCwd(s.cwd), tone: "dim" }]);
	// hc-hud hides team.member under a multiplexer; a Session in a Herdr pane runs under one.
	if (s.team && !s.location?.pane) session.push([{ text: s.title === s.team.teamId ? s.team.role : `${s.team.teamId}/${s.team.role}` }]);

	const limit = s.workingBudget ?? s.contextWindow;
	const used = s.contextTokens;
	// Without Auto Compact's context.budget slot, hc-hud shows its dim fallback: percent of the model window.
	const context = used === undefined ? "?" : limit ? `${Math.round(100 * used / limit)}%/${formatTokens(limit)}` : `${formatTokens(used)}/${ABSENT}`;
	const usage: HudSpan[][] = [
		[{ text: aliasName(s.model) }],
		[{ text: `${context} ${CYCLE}${ABSENT}`, tone: "dim" }],
		[{ text: `$${s.costUsd.toFixed(2)}${s.cacheHit !== undefined ? ` CH${Math.floor(s.cacheHit)}%` : ""}`, tone: "dim" }],
	];

	const gaps = [
		"Git branch",
		"thinking level",
		...(limit ? [] : ["context window"]),
		s.workingBudget ? "Auto Compact threshold and state" : "Auto Compact budget",
		"Rarebit count",
		"extension statuses",
		"configured model aliases",
	];
	return { lines: [join(session), join(usage)], ...(s.model && aliasName(s.model) !== s.model ? { modelId: s.model } : {}), gaps };
}
