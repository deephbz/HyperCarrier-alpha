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

const protocolNumber = (p: string) => Number(/^hc-control\/(\d+)$/.exec(p)?.[1]);

/**
 * Every sentence AmPi says about a version difference. Each pi-hc-control text has two lines: what differs, then the
 * update step. Only `controlProtocol` refuses an op; the build texts name drift in the deploy parts row. A control on
 * the hub's protocol updates itself once its Host's checkout has the build (pi-hc-control src/update.ts), and deploy:live
 * moves this machine's main checkout (scripts/main-checkout.mjs). The pull step is the fallback when that part reads
 * manual; a restart is needed only for Sessions that started before self-update shipped.
 */
export const skewText = {
	page: "This page is older than AmPi. Reload.",
	controlOlder: (host: string, old: string) =>
		`${host}'s pi-hc-control runs an older build (${old}); it updates at its next idle moment or restart.`,
	controlNewer: (host: string) => `This AmPi is older than ${host}'s pi-hc-control. Update it.\nPull AmPi on this machine, then restart the hub (npm run deploy:live in apps/ampi).`,
	controlUnstamped: (host: string) => `${host}'s pi-hc-control has no build stamp. Update it.\nPull pi-hc-control on ${host}, then restart each Pi Session there.`,
	controlProtocol: (host: string, control: string, hub: string) =>
		protocolNumber(control) < protocolNumber(hub)
			? `${host}'s pi-hc-control speaks ${control}; this AmPi speaks ${hub}. Update it.\nPull pi-hc-control on ${host}, then restart each Pi Session there.`
			: `This AmPi speaks ${hub}; ${host}'s pi-hc-control speaks ${control}. Update it.\nPull AmPi on this machine, then restart the hub (npm run deploy:live in apps/ampi).`,
	// The control names the protocol AmPi speaks but refused one of its ops as unknown: it is older than its protocol says.
	controlUnknownOp: (host: string, protocol: string) =>
		`${host}'s pi-hc-control names ${protocol} but lacks an op this AmPi's ${protocol} sends. Update it.\nPull pi-hc-control on ${host}, then restart each Pi Session there.`,
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
