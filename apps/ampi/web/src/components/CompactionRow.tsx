import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { CompactRecord } from "@hypercarrier/auto-compact-durable";
import type { PiEntry } from "../../../src/shared/protocol.ts";
import { plannerLine, recordDetail, recordLine, rowHead, rowLine } from "../../../src/shared/compact-record.ts";
import { hub } from "../client.ts";
import { clock, href } from "../util.ts";
import { Markdown } from "./Markdown.tsx";

type Compaction = Extract<PiEntry, { kind: "compaction" }>;

const KEPT = "## Tool results you chose to keep";
const RECORD = "## Conversation record";
const DROPPED = "## Dropped tool results";

/** The thread's compaction records, refetched when a compaction entry appears. */
export function useCompactRecords(host: string, threadId: string, count: number): readonly CompactRecord[] {
	const [records, setRecords] = useState<readonly CompactRecord[]>([]);
	useEffect(() => {
		if (count === 0) return;
		hub.request(host, "compact.records", { threadId }).then((r) => setRecords(r.records as CompactRecord[]), () => setRecords([]));
	}, [host, threadId, count]);
	return records;
}

/** The text under each `## ` heading of a placed summary, keyed by the heading's start. */
function sections(summary: string): Map<string, string> {
	const out = new Map<string, string>();
	const parts = summary.split(/^(?=## )/m);
	for (const part of parts) {
		const nl = part.indexOf("\n");
		const head = nl < 0 ? part : part.slice(0, nl);
		const key = [KEPT, RECORD, DROPPED].find((k) => head.startsWith(k)) ?? (head.startsWith("## Working-state summary") ? "working" : head);
		out.set(key, nl < 0 ? "" : part.slice(nl + 1).trim());
	}
	return out;
}

/** The `### tN · name …` blocks of the kept section, by label. */
function keptBlocks(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const block of text.split(/^(?=### )/m)) {
		const label = /^### (t\d+) · /.exec(block)?.[1];
		if (label) out.set(label, block.slice(block.indexOf("\n") + 1).trim());
	}
	return out;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * One compaction in the transcript. With its record (`taskId` equal to the entry's `byTaskId`), the collapsed line
 * says what was replaced, kept and dropped; its title holds the method, the reason and the figures, and the title and
 * the body's first lines hold the detail (planner cost, cache, fit arithmetic). A keepset body lists the kept outputs as tool blocks and the dropped ones as links to their
 * history entries. Without a record it is the plain summary row.
 */
export function CompactionRow({ entry, record, host, threadId, fragment, more }: { entry: Compaction; record?: CompactRecord; host: string; threadId: string; fragment?: string; more?: ReactNode }) {
	const plain = entry.summary?.startsWith("## Working-state summary") ? "HC summary with Rarebit record" : "native summary";
	const parts = record?.method === "keepset" && record.keep ? sections(entry.summary ?? "") : undefined;
	const blocks = parts ? keptBlocks(parts.get(KEPT) ?? "") : undefined;
	const link = (entryId: string | undefined, text: string) => (entryId ? <a href={href.thread(host, threadId, { entry: entryId })}>{text}</a> : null);
	const cost = record && plannerLine(record);
	const head = `Context compacted${entry.reason ? ` (${entry.reason})` : ""}`;
	const detail = record ? recordDetail(record) : [];
	return (
		<Fragment>
			<div className="compaction" data-entry={entry.id} data-fragment={fragment} data-compaction={record?.method} title={record ? [`${head} · ${recordLine(record)}`, ...detail].join("\n") : undefined}>
				{/* One line at the owner's 130 %: the method, the reason and the figures are in the title and the body. */}
				{record ? `${rowHead(record)} · ${rowLine(record)} · ${clock(entry.ts)}` : `${head} · ${plain} · ${clock(entry.ts)}`}
			</div>
			<details className="compaction-body">
				<summary className="disclosure">Summary the agent continues from</summary>
				{record && <div className="hint" data-record>{`${head} · ${recordLine(record)}`}</div>}
				{detail.map((line) => (
					<div key={line} className="hint" data-planner={line === cost ? true : undefined}>{line}</div>
				))}
				{parts && record?.keep && blocks ? (
					<>
						<Markdown text={parts.get("working") ?? ""} />
						<h4>Tool outputs kept verbatim ({record.keep.kept.length} · {k(record.keep.keptTokens)} of {k(record.keep.cap)} tokens)</h4>
						{record.keep.kept.length === 0 && <div className="hint">None kept.</div>}
						{record.keep.kept.map((kept) => (
							<details key={kept.label} className="tool" data-kept={kept.label}>
								<summary className="disclosure">
									{kept.label} · {kept.name} · {k(kept.tokens)} tokens{kept.cut ? " · cut at 8k tokens" : ""} · {link(kept.entryId, "open in history")}
								</summary>
								<Markdown text={blocks.get(kept.label) ?? ""} />
							</details>
						))}
						<Markdown text={`${RECORD}\n\n${parts.get(RECORD) ?? ""}`} />
						<h4>Dropped tool outputs ({record.keep.droppedCount})</h4>
						<ul data-dropped>
							{record.keep.dropped.map((d) => (
								<li key={d.label}>
									{d.label} · {d.name} <code>{d.args}</code> · {k(d.tokens)} tokens · {link(d.entryId, "open")}
								</li>
							))}
							{record.keep.droppedCount > record.keep.dropped.length && <li>… {record.keep.droppedCount - record.keep.dropped.length} more</li>}
						</ul>
					</>
				) : (
					<Markdown text={entry.summary} />
				)}
				{more}
			</details>
		</Fragment>
	);
}
