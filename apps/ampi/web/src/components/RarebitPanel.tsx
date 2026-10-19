import { useState } from "react";
import { hub, useTopic } from "../client.ts";
import { ago, clock, go } from "../util.ts";

// biome-ignore lint: the Rarebit view is loosely typed JSON
type Any = any;

const MARK: Record<string, { mark: string; label: string; cls: string }> = {
	user: { mark: "□", label: "user message", cls: "user_message" },
	continuation: { mark: "•", label: "agent continues", cls: "agent_continuation" },
	stop: { mark: "●", label: "agent stops", cls: "agent_stop" },
};

const STATUS: Record<string, string> = {
	finished: "Appears finished",
	needs_attention: "Needs you",
};

const REASON: Record<string, string> = {
	all_requests_accomplished: "every visible request appears accomplished",
	decision: "a decision is yours",
	input: "waiting for your input",
	approval: "waiting for your approval",
	blocker: "blocked",
	unfinished: "work remains",
	uncertain: "evidence is incomplete",
	conflicting_evidence: "evidence conflicts",
	total_length_below_minimum: "the session is shorter than the summary threshold",
	rarebit_ratio_above_maximum: "the session is mostly prose already",
	no_rarebits: "no Rarebits yet",
};

function when(ts: number): string {
	const a = ago(ts);
	return a === "now" ? "just now" : `${a} ago`;
}

function jump(entryId: string) {
	const el = document.querySelector(`[data-entry="${entryId}"]`);
	if (!el) return false;
	el.scrollIntoView({ behavior: "smooth", block: "center" });
	el.classList.remove("flash");
	void (el as HTMLElement).offsetWidth;
	el.classList.add("flash");
	return true;
}

function SummaryCard({ host, threadId, value }: { host: string; threadId: string; value: Any }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const { summary, attempt, running } = value.state ?? {};
	const since = summary ? value.items.filter((i: Any) => i.kind === "rarebit" && Number(i.entryId) > Number(summary.coveredEntryId)).length : 0;
	const summarize = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await hub.request(host, "rarebit.summarize", { threadId });
		} catch (e) {
			setError((e as Error).message);
		}
		setBusy(false);
	};
	return (
		<div className={`rb-summary ${summary?.sessionStatus ?? ""}`} data-rarebit-summary={summary?.sessionStatus ?? "none"}>
			<div className={`rb-status ${summary?.sessionStatus ?? ""}`}>
				{summary?.sessionStatus === "needs_attention" && <span>◆!</span>}
				<span>{summary ? STATUS[summary.sessionStatus] : "No Summary yet"}</span>
				{summary && <span className="hint" style={{ fontWeight: 400 }}>· {REASON[summary.statusReason] ?? summary.statusReason}</span>}
				<span style={{ flex: 1 }} />
				{running || busy ? (
					<span className="hint" style={{ fontWeight: 400 }}>
						<span className="spinner" /> summarizing…
					</span>
				) : (
					<button className="btn small" onClick={() => void summarize()} title="Summarize the evidence now (manual boundary; skips the eligibility policy)">
						Summarize now
					</button>
				)}
			</div>
			{summary && <div style={{ whiteSpace: "pre-wrap" }}>{summary.summary}</div>}
			{summary && (
				<div className="hint" style={{ marginTop: 6 }}>
					{value.fresh ? "Covers the latest evidence" : `${since} newer Rarebit${since === 1 ? "" : "s"} since`} · {summary.boundary === "manual" ? "asked by you" : "after the agent settled"} {when(summary.at)} ·{" "}
					{summary.coverage.complete ? `${summary.coverage.includedMessageCount} messages` : `${summary.coverage.includedMessageCount} of ${summary.coverage.totalMessageCount} messages (oldest trimmed)`} · {summary.model}
				</div>
			)}
			{attempt && attempt.status !== "summarized" && (attempt.coveredEntryId !== summary?.coveredEntryId || !summary) && (
				<div className="hint" style={{ marginTop: 6 }} data-rarebit-attempt={attempt.status}>
					{attempt.status === "ineligible"
						? `Not summarized automatically: ${attempt.reasons
								.map((r: string) =>
									r === "total_length_below_minimum"
										? `${REASON[r]} (≈${Math.round(attempt.estimatedTotalTokens / 100) / 10}k of ${Math.round(value.policy.minTotalLength / 100) / 10}k tokens)`
										: r === "rarebit_ratio_above_maximum"
											? `${REASON[r]} (${Math.round((attempt.rarebitRatio ?? 0) * 100)}% prose; summaries run at ≤${Math.round(value.policy.maxRarebitRatio * 100)}%)`
											: (REASON[r] ?? r),
								)
								.join("; ")}.`
						: `Last Summary failed ${when(attempt.at)}: ${attempt.error}`}
				</div>
			)}
			{error && <div className="err-box">{error}</div>}
		</div>
	);
}

/**
 * Rarebit: the sparse evidence of a thread (user messages, agent continuations, agent stops) over the full durable
 * history, with compaction boundaries and the latest Summary. Evidence the model no longer sees is marked, not hidden.
 */
export function RarebitPanel({ host, threadId }: { host: string; threadId: string }) {
	const { value } = useTopic<Any>(host, { kind: "rarebit", threadId });
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState<"all" | "user" | "stops">("all");
	if (!value) return <div className="empty">Loading…</div>;
	const items = value.items.filter(
		(i: Any) => i.kind !== "rarebit" || filter === "all" || (filter === "user" ? i.role === "user" : i.outcome !== "continuation"),
	);
	const fork = async (entryId: string) => {
		const { threadId: forked } = await hub.request<{ threadId: string }>(host, "thread.fork", { threadId, entryId });
		go(host, forked);
	};
	return (
		<div data-panel="rarebit">
			<SummaryCard host={host} threadId={threadId} value={value} />
			<div style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 6px" }}>
				<h3 style={{ margin: 0 }}>Evidence · {value.count}</h3>
				<span style={{ flex: 1 }} />
				<div className="seg small">
					{(["all", "user", "stops"] as const).map((f) => (
						<button key={f} className={f === filter ? "on" : ""} onClick={() => setFilter(f)}>
							{f === "all" ? "All" : f === "user" ? "□ User" : "□ ● Turns"}
						</button>
					))}
				</div>
			</div>
			{items.length === 0 && <div className="hint">No Rarebits yet. They appear as the user and agent talk.</div>}
			{items.map((item: Any) => {
				if (item.kind !== "rarebit")
					return (
						<div key={item.entryId} className="rb-sep" title={item.text}>
							{item.kind === "compaction" ? "context compacted" : "context reset"} {item.ts ? `· ${clock(item.ts)}` : ""} · the model sees a summary of everything above
						</div>
					);
				const m = MARK[item.outcome]!;
				const expanded = open.has(item.entryId);
				return (
					<div
						key={item.entryId}
						className={`rb-item ${expanded ? "expanded" : ""}`}
						style={item.outOfContext ? { opacity: 0.72 } : undefined}
						data-rarebit={item.outcome}
						onClick={() =>
							setOpen((prev) => {
								const next = new Set(prev);
								if (next.has(item.entryId)) next.delete(item.entryId);
								else next.add(item.entryId);
								return next;
							})
						}
					>
						<span className={`rb-mark ${m.cls}`} title={m.label}>
							{m.mark}
						</span>
						<span className="rb-label">
							{m.label} · {item.ts ? clock(Date.parse(item.ts)) : ""}
							{item.outOfContext ? " · compacted out of model context" : ""}
							{expanded && (
								<>
									{" · "}
									<a
										href="#"
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											if (!jump(item.entryId)) alert("Load earlier messages in the transcript to see this entry.");
										}}
									>
										show in transcript
									</a>
									{" · "}
									<a
										href="#"
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											void fork(item.entryId);
										}}
									>
										fork from here
									</a>
								</>
							)}
						</span>
						<div className="rb-text">{item.text}</div>
					</div>
				);
			})}
		</div>
	);
}
