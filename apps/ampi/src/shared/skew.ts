// Version skew (P1): every AmPi part runs the same build. A part with another stamp gets one of the `skewText`
// sentences, never a fallback. This module has no Node imports, so the page uses the same texts and op list;
// src/shared/build.ts computes the stamps.

/**
 * One build's identity. The fields match Arc's service stamp (`expected` in arc-v21 `src/arc/service/relay.ts`):
 * `id` is the identity, `order` the HEAD committer time in seconds, and `line` names the line for texts
 * and logs only.
 */
export type Stamp = { id: string; order: number; line: "stable" | "durable" | null };
/** The remote part's build, seen from the local one. */
export type Skew = "same" | "older" | "newer";

/**
 * The remote build relative to the local one. Equal versions are the same build. Otherwise the greater build order is
 * newer, across lines too: the durable line is main plus rebased commits. Equal orders compare the versions as text,
 * so the order is total and both sides agree.
 */
export function compare(local: Stamp, remote: Stamp): Skew {
	if (local.id === remote.id) return "same";
	if (local.order !== remote.order) return remote.order < local.order ? "older" : "newer";
	return remote.id < local.id ? "older" : "newer";
}

/** A stamp as logs and refusal details print it. */
export const stampLabel = (s: Stamp | null | undefined): string =>
	s ? `${s.id} (${s.line ?? "no line"}, ${new Date(s.order * 1000).toISOString()})` : "no stamp";

/**
 * Every sentence AmPi says about a version difference. A pi-hc-control refusal has two lines: what differs, then the
 * update step.
 */
export const skewText = {
	page: "This page is older than AmPi. Reload.",
	controlOlder: (host: string) => `${host} runs an older pi-hc-control. Update it.\nPull pi-hc-control on ${host}, then run /reload in each Pi pane there.`,
	controlNewer: (host: string) => `This AmPi is older than ${host}'s pi-hc-control. Update it.\nPull AmPi on this machine, then restart the hub (npm run deploy:live in apps/ampi).`,
	controlUnstamped: (host: string) => `${host}'s pi-hc-control has no build stamp. Update it.\nPull pi-hc-control on ${host}, then run /reload in each Pi pane there.`,
} as const;

/** The refusal code of every version difference; the composer treats it as final and keeps the draft. */
export const VERSION_SKEW = "version_skew";

/**
 * The Host ops a page of another build may still request: they only read. The hub refuses every other op from such a
 * page (every hub op too) with VERSION_SKEW and `skewText.page`, and the page refuses them itself before it sends.
 */
export const READ_OPS: ReadonlySet<string> = new Set([
	"thread.commands",
	"sessions.search",
	"thread.outline",
	"thread.find",
	"thread.history",
	"thread.entry",
	"prompts.list",
	"models.list",
	"view.cos.timeline.locate",
]);
