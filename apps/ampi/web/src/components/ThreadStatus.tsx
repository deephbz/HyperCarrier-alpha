// A Session's status marks: the activity spinner and the badges for attention, errors, queued input and Teams.
// Every Session list shows them: the sidebar rows, Pinned and Overview.

import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { ACTIVITY_LABEL, attentionOf, isBusy } from "../util.ts";

export function ActivityIcon({ t }: { t: ThreadSummary }) {
	if (isBusy(t)) return <span className="spinner" title={ACTIVITY_LABEL[t.activity]} />;
	return null;
}

const UPDATING_TITLE = "AmPi re-reads this Session after an upgrade; its title, cost and preview return when that ends";

export function ThreadBadges({ t, compact = false, hideTeam = false }: { t: ThreadSummary; compact?: boolean; hideTeam?: boolean }) {
	const attention = attentionOf(t);
	if (compact) return <>
		{t.updating && <span className="row-meta" title={UPDATING_TITLE}>updating</span>}
		{t.queued > 0 && <span className="row-meta" title={`${t.queued.toLocaleString()} queued`}>{t.queued.toLocaleString()} ↵</span>}
		{!hideTeam && t.team?.role === "lead" && <span className="row-meta">team</span>}
	</>;
	return (
		<>
			{/* A closed thread never needs the owner (attentionOf); its kept reason shows in the Closed feedback. */}
			{attention.filter((a) => a.source !== "error").slice(0, 1).map((a) => (
				<span key={a.reason} className="badge attn" title={`${a.source}: ${a.reason}`}>
					◆! {a.reason}
				</span>
			))}
			{!t.closed && t.lastError && (
				<span className="badge err" title={t.lastError}>
					× error
				</span>
			)}
			{t.updating && <span className="badge" title={UPDATING_TITLE}>updating</span>}
			{t.queued > 0 && <span className="badge">{t.queued} queued</span>}
			{attention.length === 0 && t.team?.role === "lead" && <span className="badge accent">team</span>}
		</>
	);
}
