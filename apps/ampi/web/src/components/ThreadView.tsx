import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CompanionScrollbar, PromptHeader, readingEntry, usePromptPlace, usePromptRail, useThreadOutline } from "./CompanionScrollbar.tsx";
import { carryDraft, Composer, type ComposerHandle } from "./Composer.tsx";
import { QuoteSelection } from "./QuoteSelection.tsx";
import { FormRow } from "./FormRow.tsx";
import { Popover } from "./Popover.tsx";
import { useHeaderFold } from "./header-fold.ts";
import { openAccounts } from "./Accounts.tsx";
import type { InjectedMessage, PiEntry, ToolArgsPreview } from "../../../src/shared/protocol.ts";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { openCalls } from "../../../src/shared/tool-state.ts";
import { noticeMessage } from "../../../src/shared/team-origin.ts";
import { findHost, hub, readVersioned, refusal, useHosts, useTopic } from "../client.ts";
import { INDEXING, NOT_FOUND, STALE_VERSION } from "../../../src/shared/protocol.ts";
import { isPiHost, servesHostOps } from "./Sidebar.tsx";
import { entryId, entryState, flushEntry, noteEntry, revealStore } from "../nav.ts";
import { ACTIVITY_LABEL, MOD, attentionOf, clock, go, href, money, tokens } from "../util.ts";
import { Markdown } from "./Markdown.tsx";
import { CompactionRow, useCompactRecords } from "./CompactionRow.tsx";
import { ArchiveThreadDialog, CloseAgentDialog, ResumeAgentDialog } from "./PiDialogs.tsx";
import { type LiveSlot, ToolArgs, ToolCall, type ToolResult } from "./ToolCall.tsx";
import { RevealScope } from "./reveal-open.ts";
import { markSeen } from "../seen.ts";
import { newBelow, newBelowLabel } from "./new-below.ts";
import { RarebitControls, RarebitJump, RarebitTools, useRarebitLens } from "../views/rarebit/Lens.tsx";
import { rarebitState } from "../views/rarebit/state.ts";
import { useArcReopen } from "../views/cos/arc-reopen.ts";
import { FindBar, FindFiltered, useFindHighlight, useSessionFind } from "./FindBar.tsx";
import { EntryBody, fetchEntry, shortenedLabel } from "./EntryBody.tsx";
import { PI_BANDS } from "../views/registry.ts";
import { toolRuns } from "../views/rarebit/tool-runs.ts";
import { END_BAND, atEnd, useKeepPlace } from "../keep-place.ts";
import { toCss } from "../display.ts";
import { SessionTitle } from "./SessionTitle.tsx";
import { PinStar } from "./Pinned.tsx";
import { perfMarkPainted } from "../perf.ts";
import { handleRegionScrollKey, isEditableTarget, useKeyAction } from "../keymap.ts";
import { useFocusIntent } from "../context.ts";

// biome-ignore lint: live and inbox docs are loosely typed JSON
type Any = any;

export type ModelChoice = { provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; default?: true };

const imageCache = new Map<string, Promise<{ data: string; mimeType: string }[]>>();

/** Images in a user message, fetched on demand: the transcript replica carries only their count. */
function UserImages({ host, threadId, entryId, count }: { host: string; threadId: string; entryId: string; count: number }) {
	const [images, setImages] = useState<{ data: string; mimeType: string }[]>();
	const [open, setOpen] = useState<number>();
	useEffect(() => {
		const key = `${host}|${threadId}|${entryId}`;
		let request = imageCache.get(key);
		if (!request) {
			request = Promise.all(
				Array.from({ length: count }, (_, index) =>
					hub.request(host, "thread.images", { threadId, entryId, index }).then((r) => r.image),
				),
			).then((list) => list.filter((image): image is { data: string; mimeType: string } => image !== undefined));
			imageCache.set(key, request);
			request.catch(() => imageCache.delete(key));
		}
		let live = true;
		request.then((list) => live && setImages(list), () => {});
		return () => {
			live = false;
		};
	}, [host, threadId, entryId, count]);
	if (!images) return <div className="hint">{count} image(s)</div>;
	return (
		<div className="user-images" data-images={images.length}>
			{images.map((image, i) => (
				<img key={i} src={`data:${image.mimeType};base64,${image.data}`} alt={`Image ${i + 1}`} onClick={() => setOpen(open === i ? undefined : i)} className={open === i ? "big" : ""} />
			))}
		</div>
	);
}

const firstLine = (text: string) => text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";

function NoticeParts({ message }: { message: InjectedMessage }) {
	const parts = message.parts ?? [{ text: message.text }];
	return parts.map((part, i) => (
		<Fragment key={i}>
			{parts.length > 1 && part.from && <div className="hint">{part.from}</div>}
			<Markdown text={part.text} />
		</Fragment>
	));
}

/** One extension message as one disclosure row: kind badge, sender and first line; open, its text and, when shortened, the full text in the card. */
export function NoticeEntry({ entry, host, threadId, fragment }: { entry: Extract<PiEntry, { kind: "custom" }>; host: string; threadId: string; fragment?: string }) {
	// An older node's entry (a thread the hub holds no copy of) carries its text and data but no projected message.
	const { text, data } = entry as { text?: unknown; data?: unknown };
	const message = entry.message ?? noticeMessage(entry.entryKind, data, typeof text === "string" ? text : "");
	return (
		<details className="msg notice" data-entry={entry.id} data-fragment={fragment ?? entry.id}>
			<summary className="disclosure">
				<span className={`badge ${message.kind === "alert" ? "attn" : ""}`}>{message.label}</span>
				{message.sender && <span className="notice-sender">{message.sender}</span>}
				<span className="notice-first">{firstLine(message.text)}</span>
				<span className="notice-time">{clock(entry.ts)}</span>
			</summary>
			<div className="notice-body">
				<NoticeParts message={message} />
				{entry.rawExport && <a className="notice-raw" href={entry.rawExport} target="_blank" rel="noreferrer">Open the raw export</a>}
				{entry.clipped && <EntryBody host={host} threadId={threadId} entry={entry.id} label={shortenedLabel("Text", entry.clippedBytes)} show={(full) => full.kind === "custom" && <NoticeParts message={full.message} />} />}
			</div>
		</details>
	);
}

// Memoized: earlier pages of a long thread do not re-render while the live tail streams.
/** Entries drawn in the first frame after a switch. */
/** How long a read refused as stale waits for the view to show the newer version before it reads again. */
const VERSION_WAIT = 2000;
/** A history read still pending after this long shows its quiet cue; a quick read shows none. */
const CUE_DELAY = 300;
/** A failed history read: the error box's text (what happened and what to do), and the node's own words. */
type HistoryFailure = { text: string; detail?: string; retry: () => void };
function historyFailure(error: unknown, retry: () => void): HistoryFailure {
	const message = (error as Error | undefined)?.message ?? String(error);
	const code = refusal(error);
	if (code === STALE_VERSION) return { text: "This Session kept changing while AmPi read its history, even after a fresh copy of the view. Wait for the run to settle, then retry.", detail: message, retry };
	// A node from before typed refusals (protocol.ts STALE_VERSION) sends its stale reply with a generic code.
	if ((code === undefined || code === "error" || code === "Error") && /changed; (refresh|retry)/.test(message)) {
		console.warn(`AmPi history read: old-style refusal from the node: ${message}`);
		return { text: "This node refused the read with an old-style reply. It may need the new build: restart the node, then retry.", detail: message, retry };
	}
	return { text: message, retry };
}
/** A reveal of a linked entry: the entry, the row that renders it (a tool result renders in its call), and the request. */
type Reveal = { entry: string; holder: string; seq: number };
/** How long a reveal keeps the target centred while layout moves (images, folds, bodies), and how long it waits for the row. */
const SETTLE_MS = 1500;
const RENDER_WAIT_MS = 1000;
const FIRST_PAINT = 40;
/** Messages rendered after first paint, and how many more each time the reader scrolls near the top. */
const WINDOW = 120;
/**
 * A read place: an anchor entry and its top's offset below the transcript's top. `unit: "css"` marks the offset in the
 * transcript's CSS px; a place without it predates the marker (history state outlives a reload) and holds screen px.
 */
type Place = { id: string; offset: number; limit: number; unit?: "css" };
/** Where the reader was in each Session, so Back (or returning) lands there again. */
const PLACES = new Map<string, Place>();
/** Branch summaries in a window: Pi writes one where the reader's Session moved to another branch. */
const branchMarks = (entries: PiEntry[]) => entries.flatMap((e) => e.kind === "compaction" && e.reason === "branch" ? [e.id] : []);
/** Entries after the reader's last-seen entry: a count, or "some" when that entry left the served window. */
/**
 * Painted rows split after each row that the source window followed with dropped, unpainted entries. Each segment's key
 * names the boundary that starts it, `head` for the first, so a trim above never renames or remounts a segment.
 */
function segments<T extends { id: string }>(rows: T[], omitted: Set<string>, head: string): { key: string; rows: T[] }[] {
	const parts = [{ key: head, rows: [] as T[] }];
	rows.forEach((row, i) => {
		parts.at(-1)!.rows.push(row);
		if (omitted.has(row.id) && i < rows.length - 1) parts.push({ key: `after-${row.id}`, rows: [] });
	});
	return parts;
}

const Entries = memo(function Entries({
	entries,
	live,
	host,
	threadId,
	onOpenConversation,
	canFork = true,
	lens = false,
	busy = false,
	closed = false,
	reveal,
}: {
	entries: PiEntry[];
	live: Any;
	host: string;
	threadId: string;
	onOpenConversation: (conversationId: string) => void;
	canFork?: boolean;
	lens?: boolean;
	busy?: boolean;
	/** A closed thread: Fork carries the composer's unsent draft into the fork. */
	closed?: boolean;
	/** The entry a reveal targets, the row that renders it, and the request: its folds and tool body open once per request. */
	reveal?: Reveal;
}) {
	const results = useMemo(() => {
		const map = new Map<string, ToolResult & { entry: string; clipped?: boolean; clippedBytes?: number }>();
		for (const entry of entries)
			if (entry.kind === "tool-result")
				map.set(entry.callId, { text: entry.text, isError: entry.isError, truncated: entry.truncated, entry: entry.id, clipped: entry.clipped, clippedBytes: entry.clippedBytes });
		return map;
	}, [entries]);
	const outputSource = (callId: string) => {
		const result = results.get(callId);
		return result?.clipped && <EntryBody host={host} threadId={threadId} entry={result.entry} label={shortenedLabel("Output", result.clippedBytes)} show={(full) => full.kind === "tool-result" && <>
			<pre>{full.text}</pre>
			{full.truncated && <div className="hint">The source output is longer than the hub sends.</div>}
		</>} />;
	};
	// Long prose opens inside its message: the full projected entry replaces the preview until "Show less".
	const [fullEntries, setFullEntries] = useState<ReadonlyMap<string, PiEntry>>(new Map());
	const [reading, setReading] = useState<{ id: string; error?: string }>();
	const toggleFull = async (id: string) => {
		if (fullEntries.has(id)) return setFullEntries((m) => { const next = new Map(m); next.delete(id); return next; });
		setReading({ id });
		try {
			const full = await fetchEntry(host, threadId, id);
			setFullEntries((m) => new Map(m).set(id, full));
			setReading(undefined);
		} catch (e) {
			setReading({ id, error: (e as Error).message ?? String(e) });
		}
	};
	const proseToggle = (entry: PiEntry) => entry.bodyAvailable && (
		<div className="prose-toggle">
			<button className="btn ghost small" disabled={reading?.id === entry.id && !reading.error} onClick={() => void toggleFull(entry.id)}>
				{fullEntries.has(entry.id) ? "Show less" : reading?.id === entry.id && !reading.error ? "Reading message…" : "Show full message"}
			</button>
			{reading?.id === entry.id && reading.error && <span role="alert">{reading.error}</span>}
		</div>
	);
	const blockOf = (full: PiEntry, test: (b: Extract<PiEntry, { kind: "assistant" }>["blocks"][number], i: number) => boolean) => full.kind === "assistant" ? full.blocks.find(test) : undefined;
	const slots = new Map<string, LiveSlot>();
	for (const slot of (live?.tools ?? []) as Any[]) slots.set(String(slot.callId), slot);
	const fork = async (entryId: string) => {
		const { threadId: forked } = await hub.request(host, "thread.fork", { threadId, entryId });
		if (closed) carryDraft(host, threadId, forked);
		go(host, forked);
	};
	const parts = useMemo(() => lens ? toolRuns(entries, busy) : [], [entries, lens, busy]);
	const compactRecords = useCompactRecords(host, threadId, entries.filter((e) => e.kind === "compaction").length);
	const open = useMemo(() => openCalls(entries), [entries]);
	const calls = new Set(entries.flatMap((entry) => entry.kind === "assistant" ? entry.blocks.flatMap((b) => b.type === "tool" ? [b.callId] : []) : []));
	/** `fragment` names this rendered part of the entry: the lens part key, or the entry ID for a whole entry. */
	const renderEntry = (preview: PiEntry, fragment = preview.id) => {
				const entry = fullEntries.get(preview.id) ?? preview;
				const fade = preview.bodyAvailable && !fullEntries.has(preview.id);
				const lastText = entry.kind === "assistant" ? entry.blocks.findLastIndex((b) => b.type === "text" && b.text.trim() !== "") : -1;
				const rendered = (() => { switch (entry.kind) {
					case "user":
						return (
							<div key={entry.id} className="msg user you" data-entry={entry.id} data-fragment={fragment}>
								<div className="who">
									<span className="you-label">You</span>
									<span>{clock(entry.ts)}</span>
									<span style={{ flex: 1 }} />
									{!canFork && <RarebitJump host={host} threadId={threadId} entry={entry.id} />}
									{canFork && (
									<button className="btn ghost small" title="Fork a new thread from this message" onClick={() => void fork(entry.id)}>
										Fork
									</button>
									)}
								</div>
								<div data-quote-body className={fade ? "clip-fade" : undefined}>{entry.text}</div>
								{proseToggle(preview)}
								{entry.images > 0 && <UserImages host={host} threadId={threadId} entryId={entry.id} count={entry.images} />}
							</div>
						);
					case "assistant":
						return (
							<div key={entry.id} className="msg assistant" data-entry={entry.id} data-fragment={fragment}>
								{!canFork && entry.blocks.some((b) => b.type === "text") && <RarebitJump host={host} threadId={threadId} entry={entry.id} />}
								{entry.blocks.map((block, i) =>
									block.type === "text" ? (
										i === lastText && fade ? <div key={i} className="clip-fade"><Markdown text={block.text} /></div> : <Markdown key={i} text={block.text} />
									) : block.type === "thinking" ? (
										<details key={i} className="thinking">
											<summary className="disclosure">Thinking</summary>
											<div className="body">{block.text}</div>
											{block.clipped && <EntryBody host={host} threadId={threadId} entry={entry.id} label="Thinking shortened" show={(full) => <div className="body">{(blockOf(full, (_, j) => j === i) as { text?: string } | undefined)?.text}</div>} />}
										</details>
									) : block.type === "tool" ? (
										<ToolCall
											key={block.callId}
											name={block.name}
											args={block.args}
											result={results.get(block.callId)}
											live={slots.get(block.callId)}
											callOpen={open.has(block.callId)}
											active={busy}
											source={block.argsClipped && <EntryBody host={host} threadId={threadId} entry={entry.id} label="Arguments shortened" show={(full) => {
												const args = (blockOf(full, (b) => b.type === "tool" && b.callId === block.callId) as { args?: ToolArgsPreview } | undefined)?.args;
												return args && <ToolArgs args={args} />;
											}} />}
											outputSource={outputSource(block.callId)}
											reveal={reveal && results.get(block.callId)?.entry === reveal.entry ? reveal.seq : undefined}
										/>
									) : null,
								)}
								{entry.stop === "error" && <ModelError host={host} text={entry.error ?? "unknown error"} />}
								{entry.stop === "aborted" && <div className="status-line">Interrupted.</div>}
								{proseToggle(preview)}
								{entry.stop === "length" && <div className="status-line">The answer hit the output limit.</div>}
							</div>
						);
					case "tool-result":
						return lens && !calls.has(entry.callId) ? <div key={entry.id} data-entry={entry.id} data-fragment={fragment}><ToolCall name={entry.name} args={{ summary: "" }} result={results.get(entry.callId)} outputSource={outputSource(entry.callId)} reveal={reveal?.entry === entry.id ? reveal.seq : undefined} /></div> : null;
					case "compaction":
						return (
							<CompactionRow key={entry.id} entry={entry} record={compactRecords.find((r) => r.taskId !== undefined && r.taskId === entry.byTaskId)} host={host} threadId={threadId} fragment={fragment}
								more={entry.clipped && <EntryBody host={host} threadId={threadId} entry={entry.id} label={shortenedLabel("Summary", entry.clippedBytes)} show={(full) => full.kind === "compaction" && <Markdown text={full.summary ?? ""} />} />} />
						);
					case "reset":
						return (
							<div key={entry.id} className="compaction" data-entry={entry.id} data-fragment={fragment}>
								Context reset{entry.handoff ? " with a handoff note" : ""}
							</div>
						);
					case "custom":
						return <NoticeEntry key={entry.id} entry={entry} host={host} threadId={threadId} fragment={fragment} />;
					default:
						return null;
				} })();
  return <Fragment key={entry.id}>{rendered}</Fragment>;
	};
	return <>{lens ? parts.map((part) => part.kind === "run"
		? <RarebitTools key={part.id} run={part} reveal={reveal && part.entries.some((entry) => entry.id === reveal.entry || entry.id === reveal.holder) ? reveal.seq : undefined}>{part.entries.map((entry, i) => <Fragment key={part.keys[i]}>{renderEntry(entry, part.keys[i])}</Fragment>)}</RarebitTools>
		: <Fragment key={part.key}>{renderEntry(part.entry, part.key)}</Fragment>) : entries.map((entry) => <Fragment key={entry.id}>{renderEntry(entry)}</Fragment>)}</>;
});

const NO_LIVE = {};

const AUTH_FAILURE = /\b(401|403)\b|unauthori[sz]ed|authentication|invalid[ _-]?(x-)?api[ _-]?key|incorrect api key|invalid_grant/i;

/** The model error the transcript already shows, so the run-failure box does not repeat it. */
function lastEntryShows(entries: PiEntry[], error: string): boolean {
	const last = entries.at(-1);
	return last?.kind === "assistant" && last.stop === "error" && (last.error ?? "") !== "" && error.includes(last.error!.slice(0, 60));
}

/**
 * A provider error in plain words. A rejected sign-in gets the fix one click away; the raw response stays one
 * click away too.
 */
function ModelError({ host, text, prefix = "Model error" }: { host: string; text: string; prefix?: string }) {
	const auth = AUTH_FAILURE.test(text);
	const message = /"message"\s*:\s*"([^"]+)"/.exec(text)?.[1];
	return (
		<div className="err-box" data-model-error={auth ? "auth" : "other"}>
			{auth ? (
				<>
					The model provider rejected this host's sign-in{message ? ` (${message})` : ""}.{" "}
					<button className="btn small" onClick={() => openAccounts(host)}>
						Fix sign-in
					</button>
				</>
			) : (
				<>
					{prefix}: {message ?? text.split("\n")[0]}
				</>
			)}
			{(auth || message) && (
				<details>
					<summary>Details</summary>
					<code style={{ whiteSpace: "pre-wrap" }}>{text}</code>
				</details>
			)}
		</div>
	);
}

function LivePartial({ live }: { live: Any }) {
	const message = live?.generation?.message;
	const retry = live?.generation?.retry;
	const compactions = (live?.compactions ?? []) as Any[];
	return (
		<>
			{message && (
				<div className="msg assistant">
					{(message.content ?? []).map((block: Any, i: number) =>
						block.type === "text" ? (
							<Markdown key={i} text={block.text} className="cursor-blink" />
						) : block.type === "thinking" ? (
							<details key={i} className="thinking" open>
								<summary className="disclosure">Thinking…</summary>
								<div className="body">{block.thinking}</div>
							</details>
						) : block.type === "toolCall" ? (
							<div key={i} className="status-line">
								<span className="spinner" /> preparing <code>{block.name}</code>
							</div>
						) : null,
					)}
				</div>
			)}
			{retry && (
				<div className="status-line" style={{ color: "var(--warn)" }}>
					Retrying at {clock(retry.at)}: {retry.error}
				</div>
			)}
			{compactions.map((c) => (
				<div key={c.taskId} className="status-line">
					<span className="spinner" /> Compacting ({c.reason}{c.blocking ? ", the next request waits" : ", in the background"})
				</div>
			))}
			{live?.compactionFailure && <div className="err-box">Compaction failed: {live.compactionFailure.error}</div>}
		</>
	);
}

export function ThreadView({
	host,
	threadId,
	summary,
	models,
	panel,
	setPanel,
	entry,
}: {
	host: string;
	threadId: string;
	summary?: ThreadSummary;
	models: ModelChoice[];
	panel: string | undefined;
	setPanel: (panel: string | undefined) => void;
	/** An entry to scroll to and mark, from a link (`?e=`). */
	entry?: string;
}) {
	const { value: view, stale, error } = useTopic(host, { kind: "thread", threadId });
	// One mount per Session (App keys this view by it): the first painted transcript ends the switch.
	const viewArrived = view !== undefined;
	useEffect(() => {
		if (viewArrived) perfMarkPainted("switch-done");
	}, [viewArrived]);
	const hostState = findHost(useHosts().hosts, host);
	// `reader`: the Host source serves HostOps and reader views (Find, Rarebit, Arc, history pages). `pi`: Herdr runs it.
	const reader = servesHostOps(hostState);
	const pi = isPiHost(hostState);
	// A Session opens with Arc when the owner last showed it and the pane is wide; a narrow pane collapses it (R16).
	useArcReopen(reader, panel, setPanel);
	// Find opens at the reader's place.
	const find = useSessionFind(host, threadId, () => readingEntry(scroller.current), view);
	const findBar = useRef<HTMLDivElement>(null);
	const focusIntent = useFocusIntent();
	// ⌘F opens the bar, or takes the reader back to its query.
	useKeyAction("find", reader ? (event) => { event.preventDefault(); find.show(); findBar.current?.querySelector("input")?.select(); } : undefined);
	// The chord and the palette archive an idle thread at once and offer Undo; a working thread or a Team lead confirms first.
	const [archivedToast, setArchivedToast] = useState(false);
	useEffect(() => { if (archivedToast) { const timer = setTimeout(() => setArchivedToast(false), 6000); return () => clearTimeout(timer); } }, [archivedToast]);
	useEffect(() => setArchivedToast(false), [host, threadId]);
	useKeyAction("archive", !pi && !hostState?.buildMismatch && summary && summary.team?.role !== "worker" ? (event) => {
		event.preventDefault();
		if (summary.archived) void hub.request(host, "thread.archive", { threadId, archived: false });
		else if (summary.activity === "idle" && summary.team?.role !== "lead") void hub.request(host, "thread.archive", { threadId, archived: true }).then(() => setArchivedToast(true), () => {});
		else setClosing(true);
	} : undefined);
	const scroller = useRef<HTMLDivElement>(null);
	useFindHighlight(scroller, find.open ? find.query : "", find.tools, find.at === undefined ? undefined : find.matches[find.at]?.entry);
	const composer = useRef<ComposerHandle>(null);
	const pinned = useRef(true);
	/** The first entry of the paint window, held while the reader is away from the newest end. */
	const held = useRef<string | undefined>(undefined);
	/** How many entries the paint window covers, before the lens widens it. */
	const painted = useRef(FIRST_PAINT);
	/** Painted entries that the source window evicted from its front while the reader was away from the newest end. */
	const kept = useRef<PiEntry[]>([]);
	/** While the reader is away, the last painted entry: entries that arrive after it only feed "↓ N new". */
	const last = useRef<string | undefined>(undefined);
	/** Painted entries followed by entries the source window dropped unpainted. */
	const omitted = useRef(new Set<string>());
	/** The React key of the first painted segment: the omission boundary above it, which a trim must not rename. */
	const head = useRef("head");
	const clearOmitted = () => {
		omitted.current.clear();
		head.current = "head";
	};
	const shownRef = useRef<PiEntry[]>([]);
	/** Kept and served entries, the rows a paint window can cover. */
	const allRef = useRef<PiEntry[]>([]);
	// The bottom of a frozen window is not the newest end: a reader there stays away and the window extends instead.
	const tailPainted = useCallback(() => !last.current || last.current === allRef.current.at(-1)?.id, []);
	const keepPlace = useKeepPlace(scroller, "[data-entry]", "data-entry", pinned, END_BAND, tailPainted);
	const [jump, setJump] = useState<Reveal & { threadId: string }>();
	/** Advances on each Transcript-mode toggle (RevealScope). */
	const [revealScope, setRevealScope] = useState(0);
	// The toggle ends the reveal and closes every tool body and fold a reveal opened; what the reader opened stays.
	const beforeLensChange = useCallback(() => {
		keepPlace.capture({ accept: (node) => node.matches(".msg.user, .compaction, .notice") || Boolean(node.querySelector(".md")) });
		setJump(undefined);
		setRevealScope((n) => n + 1);
	}, [keepPlace.capture]);
	const lens = useRarebitLens(host, threadId, reader, beforeLensChange);
	useKeyAction("transcript.mode", reader ? (event) => {
		if (event.target instanceof HTMLElement && event.target.closest("select, [role=dialog]")) return;
		event.preventDefault();
		const state = rarebitState(host, threadId);
		beforeLensChange();
		state.set({ lens: !state.get().lens });
	} : undefined);
	const [older, setOlder] = useState<PiEntry[]>([]);
	const [olderMore, setOlderMore] = useState(true);
 const [historyError, setHistoryError] = useState<HistoryFailure>();
	/** Counts Retry presses on a failed citation jump; the jump effect reruns on each. */
	const [jumpAttempt, setJumpAttempt] = useState(0);
	/** The quiet cue of a history read that is still pending (a citation jump, an earlier page). */
	const [historyCue, setHistoryCue] = useState<string>();
	/** Why a linked entry (`?e=`) is not shown: off the current branch, not indexed yet, beyond the paged history, or not rendered. */
	const [missing, setMissing] = useState<{ entry: string; why: "branch" | "indexing" | "paged" | "render" }>();
	/** The reveal request this transcript serves: the route's linked entry, asked again on each followed link. */
	const request = useSyncExternalStore(revealStore.subscribe, revealStore.get);
	const want = request && request.thread === threadId ? request : undefined;
	// A history read pinned to the view's version can race a live update (a compaction, a new entry): the node refuses
	// it as stale, and the read waits here for the view to show the newer version.
	const sourceVersion = useRef(view?.sourceVersion);
	const versionWaiters = useRef(new Set<() => void>());
	useEffect(() => {
		sourceVersion.current = view?.sourceVersion;
		for (const wake of [...versionWaiters.current]) wake();
	}, [view?.sourceVersion]);
	const nextVersion = useCallback((stale: string | undefined) => new Promise<string | undefined>((done) => {
		if (sourceVersion.current !== stale) return done(sourceVersion.current);
		const wake = () => { clearTimeout(timer); versionWaiters.current.delete(wake); done(sourceVersion.current); };
		const timer = setTimeout(wake, VERSION_WAIT);
		versionWaiters.current.add(wake);
	}), []);
	// The bounded stale reads failed: replace the view with a fresh snapshot once, and read once more after it.
	const refreshView = useCallback(() => { hub.refresh(host, { kind: "thread", threadId }); }, [host, threadId]);
	const readHistory = async <T,>(cue: string, read: (version: string | undefined) => Promise<T>, version: string | undefined): Promise<T> => {
		const shown = setTimeout(() => setHistoryCue(cue), CUE_DELAY);
		try { return await readVersioned(read, version, nextVersion, refreshView); }
		finally { clearTimeout(shown); setHistoryCue(undefined); }
	};
	const moreRef = useRef<HTMLDetailsElement>(null);
	const [moreOpen, setMoreOpen] = useState(false);
	const foldGroup = useRef<HTMLSpanElement>(null);
	const folded = useHeaderFold(foldGroup);
	// "↓ 2 new messages, 5 tool uses": the newest entry when the reader left the end; entries after it arrived below the
	// reader (new-below.ts counts them). A last-seen entry that slid out of the window leaves "↓ new" without a number.
	const [away, setAway] = useState<{ last?: string }>();
	const noteAway = () => { if (!pinned.current !== (away !== undefined)) setAway(pinned.current ? undefined : { last: view?.entries.at(-1)?.id }); };
	const fresh = newBelow(view?.entries ?? [], away);
	// Only explicit branch evidence starts the count again: the newest entry is gone and the window carries a branch
	// summary it did not carry before. A missing newest entry alone is a window that moved past it (a coalesced
	// snapshot, a reconnect), so the button stays and reads "↓ new".
	const newest = view?.entries.at(-1)?.id;
	const [tip, setTip] = useState(() => ({ id: newest, marks: branchMarks(view?.entries ?? []) }));
	if (newest !== tip.id) {
		const entries = view?.entries ?? [];
		const marks = branchMarks(entries);
		setTip({ id: newest, marks });
		if (away && tip.id && newest && !entries.some((e) => e.id === tip.id) && marks.some((m) => !tip.marks.includes(m))) setAway({ last: newest });
	}
	const toEnd = () => {
		const el = scroller.current;
		if (!el) return;
		pinned.current = true;
		thaw();
		keepPlace.follow();
		el.focus({ preventScroll: true }); // the button goes away; the keys keep scrolling the transcript
		setAway(undefined);
	};
	const [title, setTitle] = useState(summary?.title ?? "");
	useEffect(() => setTitle(summary?.title ?? ""), [summary?.title]);
	useEffect(() => {
		setOlder([]);
		setOlderMore(true);
  setHistoryError(undefined);
		pinned.current = true;
		held.current = undefined;
		kept.current = [];
		last.current = undefined;
		clearOmitted();
		setAway(undefined);
	}, [threadId]);
	// The newest entries paint first; the rest follow right after, so a switch shows the latest turn at once.
	const [limit, setLimit] = useState(FIRST_PAINT);
	const [closing, setClosing] = useState(false);
	const [resuming, setResuming] = useState(false);
	// A place to restore, taken when this Session opens (Back, or switching back to it), unless a link names an entry.
	const restore = useRef<Place | undefined>(undefined);
	const [, setRestoreTick] = useState(0);
	useEffect(() => {
		const key = `${host}/${threadId}`;
		const fromHistory = entryState().place as (Place & { key: string }) | undefined;
		// Precedence (D20): this history entry's place, then the link's ?e= entry, then this Session's last place. The
		// entry place makes Back return to where that entry was read; the newest end clears both places (savePlace).
		const place = fromHistory?.key === key ? fromHistory : entry ? undefined : PLACES.get(key);
		restore.current = place;
		if (place) pinned.current = false;
		setLimit(place ? Math.max(place.limit, FIRST_PAINT) : FIRST_PAINT);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const frame = requestAnimationFrame(() => {
			// Then a window, not the whole Session: older messages render as the reader scrolls up to them.
			// Rows added above a reader away from the newest end (a linked entry) keep that reader's place, like growWindow.
			// Only a growth that changes the limit commits a render that consumes `grow`.
			timer = setTimeout(() => {
				const el = scroller.current;
				if (el && !pinned.current && !restore.current && limitRef.current < WINDOW) keepPlace.capture();
				setLimit((l) => Math.max(l, WINDOW));
			}, 0);
		});
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [host, threadId]);
	// Remember the reader's place as they scroll (once a frame), so leaving and coming back lands there again.
	const saving = useRef(0);
	const savePlace = () => {
		if (saving.current) return;
		// The entry scrolled in; the frame below can run after a navigation.
		const at = entryId();
		saving.current = requestAnimationFrame(() => {
			saving.current = 0;
			const el = scroller.current;
			const key = `${host}/${threadId}`;
			if (!el || restore.current) return;
			if (atEnd(el, END_BAND) && tailPainted()) {
				PLACES.delete(key); // at the newest end: come back there, following new messages
				noteEntry({ place: undefined }, at);
				return;
			}
			const top = el.getBoundingClientRect().top;
			const anchor = [...el.querySelectorAll<HTMLElement>("[data-entry]")].find((n) => n.getBoundingClientRect().bottom > top);
			if (!anchor) return;
			const id = anchor.dataset.entry!;
			// Back/open restores the first fragment of this entry, so save its offset too, in the transcript's CSS px: a
			// restore adds it to scrollTop, also at another display size.
			const first = el.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"]`)!;
			const place: Place = { id, offset: toCss(first.getBoundingClientRect().top - top, el), limit: painted.current, unit: "css" };
			PLACES.set(key, place);
			// Also on this history entry, so Back and Forward return to where each entry was read (Amp's thread page
			// restores per history entry too). The write is deferred and keeps the URL.
			noteEntry({ place: { key, ...place } }, at);
		});
	};
	// Back or Forward within the same Session (for example after following an entry link) restores that entry's place.
	useEffect(() => {
		const key = `${host}/${threadId}`;
		const pop = () => {
			const place = entryState().place as (Place & { key: string }) | undefined;
			if (!place || place.key !== key) return;
			restore.current = place;
			pinned.current = false;
			setLimit((l) => Math.max(l, place.limit));
			setRestoreTick((n) => n + 1);
		};
		window.addEventListener("popstate", pop);
		return () => window.removeEventListener("popstate", pop);
	}, [host, threadId]);
	useEffect(() => () => cancelAnimationFrame(saving.current), [host, threadId]);
	// Where the transcript area sits in the window: a panel that has to overlay the main (narrow windows) covers only
	// the transcript, never the topbar or the composer's Send, Steer, and Stop. The slot's `top` and `bottom` are its own
	// CSS px, which the page and panel zoom scale; the rect is screen px.
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const root = document.documentElement.style;
		const measure = () => {
			const r = el.getBoundingClientRect();
			const slot = document.querySelector(".panel-slot") ?? document.documentElement;
			root.setProperty("--transcript-top", `${Math.round(toCss(r.top, slot))}px`);
			root.setProperty("--transcript-bottom", `${Math.round(toCss(window.innerHeight - r.bottom, slot))}px`);
		};
		measure();
		// App applies the region zoom after this effect and after this listener run, so measure once more a frame later.
		let frame = requestAnimationFrame(measure);
		const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		window.addEventListener("resize", measure);
		window.addEventListener("ampi:display", later);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", measure);
			window.removeEventListener("ampi:display", later);
			root.removeProperty("--transcript-top");
			root.removeProperty("--transcript-bottom");
		};
	}, [threadId, panel]);
	const limitRef = useRef(FIRST_PAINT);
	limitRef.current = limit;
	// Growing the window upward keeps what the reader is looking at in place: an anchor, so rows that arrive below in
	// the same commit do not move it.
	const growWindow = () => {
		if (!view || held.current === allRef.current[0]?.id) return;
		keepPlace.capture();
		setLimit(painted.current + WINDOW);
	};
	// A frozen window changes only by the reader: a scroll near its bottom extends it, G or "↓ N new" thaws it.
	const [frozen, setFrozen] = useState(0);
	const extending = useRef(false);
	const thaw = () => {
		kept.current = [];
		last.current = undefined;
		clearOmitted();
		setFrozen((n) => n + 1);
	};
	const growBelow = () => {
		const all = allRef.current;
		const end = last.current ? all.findIndex((e) => e.id === last.current) : -1;
		if (extending.current || pinned.current || end < 0 || end >= all.length - 1) return;
		extending.current = true;
		const read = keepPlace.capture();
		const stop = Math.min(all.length - 1, end + WINDOW);
		last.current = all[stop].id;
		// Rows more than WINDOW above the read entry may go: "Read an earlier page" pages them back by id.
		const at = read ? all.findIndex((e) => e.id === read.id) : -1;
		const start = all.findIndex((e) => e.id === held.current);
		if (at - WINDOW > start && start >= 0) {
			held.current = all[at - WINDOW].id;
			setLimit(stop + 1 - (at - WINDOW));
		}
		setFrozen((n) => n + 1);
	};
	const shown = useMemo(() => {
		const source = view?.entries ?? [];
		const before = allRef.current;
		// The source window serves a bounded tail and drops its oldest entries as entries arrive, many at once after a
		// reconnect. A reader away from the newest end keeps a frozen window: the painted rows the source dropped stay,
		// and arrivals past its last row paint nothing. A window without any overlap starts again at its newest end.
		if (pinned.current) {
			kept.current = [];
			last.current = undefined;
			clearOmitted();
		} else if (source.length && before.length) {
			last.current ??= shownRef.current.at(-1)?.id;
			const first = before.findIndex((e) => e.id === source[0].id);
			if (first > 0) {
				const from = Math.max(0, before.findIndex((e) => e.id === shownRef.current[0]?.id));
				const end = last.current ? before.findIndex((e) => e.id === last.current) + 1 : before.length;
				kept.current = before.slice(from, Math.min(end, first));
				if (end < first && kept.current.length) omitted.current.add(kept.current.at(-1)!.id);
			} else if (first < 0) {
				kept.current = [];
				if (!source.some((e) => e.id === last.current)) {
					last.current = undefined;
					clearOmitted();
				}
			}
		}
		const entries = kept.current.length ? [...kept.current, ...source] : source;
		allRef.current = entries;
		let end = last.current ? entries.findIndex((e) => e.id === last.current) + 1 : entries.length;
		if (end <= 0) {
			last.current = undefined;
			end = entries.length;
		}
		if (!pinned.current) last.current ??= entries[end - 1]?.id;
		for (const id of omitted.current) if (!entries.some((e) => e.id === id)) omitted.current.delete(id);
		let start = Math.max(0, end - limit);
		// While the reader is away from the newest end, arrivals add rows below and remove none above. The read entry then
		// needs no place correction, and no correction scroll reaches growWindow as if the reader had scrolled up.
		const at = held.current && !pinned.current ? entries.findIndex((e) => e.id === held.current) : -1;
		if (at >= 0 && at < start) start = at;
		held.current = entries[start]?.id;
		painted.current = end - start;
		// Keep the preceding prose and its complete run when the paint window cuts through tool traffic.
		if (lens) while (start > 0) {
			const previous = entries[start - 1];
			start--;
			if (previous.kind === "user" || (previous.kind === "assistant" && previous.blocks.some((b) => b.type === "text" && b.text.trim()))) break;
		}
		// The first segment keeps the key of the boundary above it, also after that boundary row leaves the source.
		const boundary = entries.slice(0, start).findLast((e) => omitted.current.has(e.id));
		if (boundary) head.current = `after-${boundary.id}`;
		else if (entries.slice(start).some((e) => `after-${e.id}` === head.current)) head.current = "head";
		return (shownRef.current = entries.slice(start, end));
	}, [view, limit, lens, frozen]);
	useLayoutEffect(() => {
		extending.current = false;
		const el = scroller.current;
		if (!el) return;
		if (restore.current) {
			const place = restore.current;
			const anchor = el.querySelector<HTMLElement>(`[data-entry="${CSS.escape(place.id)}"]`);
			if (anchor) {
				const offset = place.unit === "css" ? place.offset : toCss(place.offset, el);
				const target = el.scrollTop + toCss(anchor.getBoundingClientRect().top - el.getBoundingClientRect().top, el) - offset;
				el.scrollTop = target;
				// WebKit keeps scrollTop in whole CSS px and rounds a write down, a screen px or more at display zoom.
				if (Math.abs(el.scrollTop - target) >= 0.5) el.scrollTop = Math.round(target);
				restore.current = undefined;
				keepPlace.record();
			} else if (view && limit >= place.limit) {
				// The remembered entry is gone (another branch, or compacted away): fall back to the newest end.
				restore.current = undefined;
				pinned.current = true;
				keepPlace.follow();
			}
		} else if (keepPlace.following()) keepPlace.follow();
	});
	const openConversation = useCallback(
		(conversationId: string) => {
			const storeId = threadId.slice(0, threadId.lastIndexOf("."));
			go(host, `${storeId}.${conversationId}`);
		},
		[host, threadId],
	);
	const loadOlder = async () => {
		const first = older[0]?.id ?? kept.current[0]?.id ?? view?.entries[0]?.id;
		if (!first) return;
  setHistoryError(undefined);
  try {
		const page = await readHistory("Loading earlier entries…", (version) => hub.request(host, "thread.history", { threadId, before: first, limit: 200, version }), view?.sourceVersion);
		pinned.current = false;
		// Earlier messages arrive above: keep the message being read where it is.
		keepPlace.capture();
		setOlder((prev) => [...page.entries, ...prev].slice(0, reader ? 400 : undefined));
		setOlderMore(page.more);
  } catch (error) { setHistoryError(historyFailure(error, () => void loadOlderRef.current())); }
	};
	// Retry reads with the current window and version, not the ones the failed read closed over.
	const loadOlderRef = useRef(loadOlder);
	loadOlderRef.current = loadOlder;
	// A reveal request for one entry (`?e=`): load it, then bring it to the middle and mark it, once per request. While the
	// Host still indexes, the read repeats at each new version until the Host finds the entry or says it is off-branch.
	const waitingIndex = missing?.why === "indexing" ? view?.sourceVersion : undefined;
	useEffect(() => {
		const entry = want?.entry;
		if (!entry || !view) return;
		if (missing?.why !== "indexing") setMissing(undefined);
		setHistoryError(undefined);
		let cancelled = false;
		void (async () => {
			let before = older[0]?.id ?? view.entries[0]?.id;
			let pages = 0;
			const loaded = () => older.some((e) => e.id === entry) || view.entries.some((e) => e.id === entry);
			const collected: PiEntry[] = [];
			if (!loaded() && reader) {
				try {
					const page = await readHistory("Loading entry…", (version) => hub.request(host, "thread.history", { threadId, around: entry, version }), view.sourceVersion);
					if (cancelled) return;
					collected.push(...page.entries); setOlder(page.entries); setOlderMore(page.more);
				} catch (error) {
					// The Host names the cause: an entry the branch does not hold, or one it has not indexed yet; any other refusal
					// says what failed.
					if (cancelled) return;
					const code = refusal(error);
					if (code === NOT_FOUND) setMissing({ entry, why: "branch" });
					else if (code === INDEXING) setMissing({ entry, why: "indexing" });
					else { setMissing(undefined); setHistoryError(historyFailure(error, () => setJumpAttempt((n) => n + 1))); }
					return;
				}
			} else if (!loaded()) {
				let more = olderMore;
				while (more && before && pages < 50 && !cancelled) {
					const page = await hub.request(host, "thread.history", { threadId, before, limit: 500 });
					collected.unshift(...page.entries);
					more = page.more;
					before = page.entries[0]?.id;
					pages++;
					if (page.entries.some((e) => e.id === entry)) break;
				}
				if (cancelled) return;
				if (collected.length) {
					setOlder((prev) => [...collected, ...prev]);
					setOlderMore(more);
				}
			}
			const all = [...collected, ...older, ...(view.entries ?? [])];
			const target = all.find((e) => e.id === entry) as Any;
			if (!target) { setMissing({ entry, why: reader ? "branch" : "paged" }); return; }
			setMissing(undefined);
			// A tool result renders inside its call: the assistant message that made the call holds it.
			const holder = target.kind === "tool-result" ? (all.find((e) => (e as Any).blocks?.some((b: Any) => b.callId === target.callId)) as Any) : undefined;
			const index = view.entries.findIndex((e) => e.id === (holder?.id ?? entry));
			// A frozen window paints nothing past its last row: a target below it thaws the window.
			const end = last.current ? allRef.current.findIndex((e) => e.id === last.current) : -1;
			const at = allRef.current.findIndex((e) => e.id === (holder?.id ?? entry));
			if (end >= 0 && at > end) thaw();
			setLimit((l) => (index < 0 ? Number.POSITIVE_INFINITY : Math.max(l, view.entries.length - index + 20)));
			pinned.current = false;
			setJump({ entry, holder: holder?.id ?? entry, seq: want!.seq, threadId });
		})();
		return () => {
			cancelled = true;
		};
		// Re-run on each request, when the first view arrives, on Retry, and at each new version while the Host indexes;
		// not on every live update.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [want?.seq, threadId, Boolean(view), jumpAttempt, waitingIndex]);
	// History, the paint limit and the opened folds commit before the target is looked up; it may also render a frame
	// later (a fold opens in its own effect). Then the target stays centred while layout settles (images, bodies), and is
	// marked once. Only the current request settles: a newer one, or none (Back), ends it at once. The transcript is
	// aria-busy while the reveal settles: its place is not final until then.
	useLayoutEffect(() => {
		const root = scroller.current;
		if (!jump || jump.threadId !== threadId || jump.seq !== want?.seq || !root) return;
		const t0 = performance.now(), at = entryId();
		let frame = 0, marked: HTMLElement | undefined, stopped = false;
		root.setAttribute("aria-busy", "true");
		const settled = () => root.removeAttribute("aria-busy");
		const stop = () => { stopped = true; settled(); };
		// The reader takes over: a wheel, a touch or a key ends the settling.
		root.addEventListener("wheel", stop, { passive: true });
		root.addEventListener("pointerdown", stop);
		root.addEventListener("keydown", stop);
		const find = () => {
			const row = [...root.querySelectorAll<HTMLElement>(`[data-entry="${CSS.escape(jump.holder)}"]`)].find((n) => !n.closest("summary"));
			const part = jump.holder !== jump.entry ? row?.querySelector<HTMLElement>(`[data-result-entry="${CSS.escape(jump.entry)}"]`) : null;
			return part ?? row;
		};
		const tick = () => {
			if (stopped) return;
			const el = find();
			const ms = performance.now() - t0;
			if (!el) {
				if (ms > RENDER_WAIT_MS) { settled(); setMissing({ entry: jump.entry, why: "render" }); return; }
				frame = requestAnimationFrame(tick);
				return;
			}
			const box = root.getBoundingClientRect(), r = el.getBoundingClientRect();
			// A row taller than the transcript shows its top.
			const delta = r.height > box.height ? r.top - box.top - 12 : r.top + r.height / 2 - (box.top + box.height / 2);
			if (Math.abs(delta) > 2) root.scrollTop += toCss(delta, root);
			// A scroll event queued before the jump may have pinned the reader to the newest end again; the jump unpins.
			pinned.current = false;
			keepPlace.record();
			if (marked !== el) {
				// The request is served: Back, Forward and a reload return to the reading place, not to a new reveal (D20).
				// Written at once: one write per reveal, and Chromium drops a write made on pagehide before a reload.
				if (!marked) { noteEntry({ revealed: true }, at); flushEntry(); }
				// A re-mounted row is marked again.
				marked = el;
				el.classList.remove("flash");
				void el.offsetWidth;
				el.classList.add("flash");
			}
			if (ms < SETTLE_MS) frame = requestAnimationFrame(tick);
			// The settled reveal is the reading place.
			else { settled(); savePlace(); }
		};
		tick();
		return () => {
			cancelAnimationFrame(frame);
			settled();
			root.removeEventListener("wheel", stop);
			root.removeEventListener("pointerdown", stop);
			root.removeEventListener("keydown", stop);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [jump, threadId, want?.seq]);
	const busy = Boolean((view?.live as Any)?.run);
	// Opening a Session, and watching it update, counts as having seen its answers (Timeline "needs you").
	useEffect(() => {
		if (view && document.visibilityState === "visible") markSeen(`${host}/${threadId}`);
	}, [host, threadId, view]);
	const parent = summary?.parentId;
	const outline = useThreadOutline(host, threadId, reader ? view?.sourceVersion : undefined, missing?.entry);
	const promptPlace = usePromptPlace(scroller, outline.outline, reader);
	const closeFind = () => { find.close(); focusIntent("find.close"); };
	// A reveal from elsewhere (a link, a prompt step, the rail) shows the full transcript.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => { if (want) find.endFilter(); }, [want?.seq]);
	const paneActions = pi && summary?.live && summary.location?.pane ? summary : undefined;
	const threadActions = !pi && reader && summary?.live ? summary : undefined;
	// More exists while it holds something; when it goes, it goes closed.
	const hasMore = !!paneActions || !!threadActions || folded;
	useEffect(() => { if (!hasMore) setMoreOpen(false); }, [hasMore]);
	// The header's secondary actions: one list, drawn in the bar or as More items (header-fold.ts decides which).
	const secondary = (place: "bar" | "menu") => {
		const btn = place === "bar" ? "btn ghost small" : undefined;
		return <>
			{pi && summary && !summary.live && <button className={btn} title="Start Pi on this Session again, in a Herdr pane" onClick={() => setResuming(true)}>Resume</button>}
			{/* Owners compact with /compact or /auto-compact run; the header keeps no Compact button. */}
			{reader && <RarebitControls host={host} threadId={threadId} panel={panel} setPanel={setPanel} beforeLensChange={beforeLensChange} place={place} />}
		</>;
	};
	const findMarks = useMemo(() => find.open && find.query.trim() ? find.matches.map((hit, i) => ({ id: hit.entry, prompt: hit.prompt, cur: i === find.at })) : undefined, [find.open, find.query, find.matches, find.at]);
	// A Session with a rail hides the native scrollbar; one without keeps it and draws no Find marks.
	const rail = usePromptRail(reader ? outline.outline : undefined, promptPlace, findMarks);
	return (
		<div className="main">
			{/* The Session name is the field; run state shows in the transcript tail and the composer's Stop. */}
			<FormRow className="topbar thread-bar" field={
				<SessionTitle title={title} summary={summary} host={host} parent={parent && <a href={href.thread(host, parent)} onClick={(e) => (e.preventDefault(), go(host, parent))}>↑ parent</a>}>
				<input
					className="t-title"
					value={title}
					aria-label="Thread title"
					title={title}
					readOnly={pi}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={() => title !== summary?.title && void hub.request(host, "thread.rename", { threadId, title })}
					onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
				/>
				</SessionTitle>
			}>
				{stale && <span className="badge err">{error ?? "reconnecting…"}</span>}
				{pi && summary && !summary.live && <span className="badge">not running</span>}
				{/* The Archived badge is the one live status; the toast only carries Undo. */}
				{archivedToast && <div className="toast">Archived · <button className="link-button" onClick={() => { setArchivedToast(false); void hub.request(host, "thread.archive", { threadId, archived: false }); }}>Undo</button></div>}
				{!pi && summary?.archived && <div className="badge" role="status">Archived · <button className="link-button" disabled={hostState?.buildMismatch} title={hostState?.buildMismatch ? "This node needs the new build" : undefined} onClick={() => void hub.request(host, "thread.archive", { threadId, archived: false })}>Unarchive</button></div>}
				<PinStar host={host} threadId={threadId} title={summary?.title || title} />
				{reader && (
					<button className="btn ghost small" aria-label="Find in this Session" aria-expanded={find.open} title={`Find in this Session (${MOD}F)`} onClick={() => (find.open ? closeFind() : find.show())}>
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3.25 3.25" /></svg>
					</button>
				)}
				{/* The name and the primary actions always show; the secondary actions fold into More when short (header-fold.ts). */}
				<span className="header-fold" ref={foldGroup} data-folded={folded || undefined} inert={folded || undefined}>
					{secondary("bar")}
				</span>
				{hasMore && (
					<details className="t-more" ref={moreRef} onToggle={(e) => setMoreOpen(e.currentTarget.open)} onClick={(e) => (e.target as HTMLElement).closest("a, button") && moreRef.current?.removeAttribute("open")}>
						<summary className="btn ghost small" aria-label="More actions" title="More actions">
							⋯
						</summary>
						{moreOpen && <Popover className="t-more-menu" anchor={() => moreRef.current?.querySelector("summary")?.getBoundingClientRect()} align="end" gap={4} owner={moreRef.current?.querySelector("summary")} onClose={() => moreRef.current?.removeAttribute("open")} menu>
							{folded && secondary("menu")}
							{folded && (paneActions || threadActions) && <hr />}
							{threadActions && (
								<>
									<button title={`Start a thread after this one, in its tab (${MOD}N)`} onClick={() => window.dispatchEvent(new Event("ampi:new"))}>
										New thread beside
									</button>
									{threadActions.team?.role === "worker" ? <button disabled title="The lead manages Workers">Archive thread</button> : <button disabled={hostState?.buildMismatch} title={hostState?.buildMismatch ? "This node needs the new build" : "Stop owned work and put this thread away"} onClick={() => threadActions.activity === "idle" && threadActions.team?.role !== "lead" ? void hub.request(host, "thread.archive", { threadId, archived: true }) : setClosing(true)}>Archive thread</button>}
								</>
							)}
							{paneActions && (
								<>
									<button title={`Start another agent in a pane beside this one (${MOD}N)`} onClick={() => window.dispatchEvent(new Event("ampi:new"))}>
										New agent beside
									</button>
									{paneActions.team && paneActions.team.role !== "lead" ? (
										<button disabled title="Pi Team Bright owns this worker's pane: ask its lead to stop it">
											Close pane
										</button>
									) : (
										<button title="Stop Pi and free its Herdr pane; Resume starts it again" onClick={() => setClosing(true)}>
											Close pane…
										</button>
									)}
								</>
							)}
						</Popover>}
					</details>
				)}
			</FormRow>
			{resuming && summary && <ResumeAgentDialog host={host} summary={summary} onClose={() => setResuming(false)} />}
			{closing && summary && (pi ? <CloseAgentDialog host={host} summary={summary} onClose={() => setClosing(false)} /> : <ArchiveThreadDialog host={host} summary={summary} onClose={() => setClosing(false)} />)}
			{reader && find.open && <div ref={findBar}><FindBar find={find} onClose={closeFind} /></div>}
			{reader && (view?.agent as Any)?.readError && <p className="err-box" role="status">Last indexed copy · {(view!.agent as Any).readError}. New source bytes retry the read.</p>}
			{historyCue && !historyError && (
				<div className="entry-missing" role="status" data-history-cue>
					<span>{historyCue}</span>
				</div>
			)}
			{historyError && (
				<div className="err-box dismissible" role="status">
					<span title={historyError.detail}>{historyError.text}</span>
					<button className="btn ghost small" onClick={() => { const { retry } = historyError; setHistoryError(undefined); retry(); }}>
						Retry
					</button>
					<button className="btn ghost small" onClick={() => setHistoryError(undefined)}>
						Dismiss
					</button>
				</div>
			)}
			{missing && (
				<div className="entry-missing" role="status" data-why={missing.why}>
					<span>
						{missing.why === "branch" ? <>The linked entry <code>{missing.entry}</code> is not on this Session's current branch. It may be on an abandoned branch or compacted away.</>
							: missing.why === "indexing" ? <>The linked entry <code>{missing.entry}</code> is not indexed yet. AmPi shows it when indexing reaches it.</>
							: missing.why === "paged" ? <>The linked entry <code>{missing.entry}</code> is not within the newest 25,000 entries of this copied branch.</>
							: <>The linked entry <code>{missing.entry}</code> loaded but did not render. Retry, or report this Session.</>}
					</span>
					{missing.why === "render" && <button className="btn ghost small" onClick={() => { setMissing(undefined); setJumpAttempt((n) => n + 1); }}>Retry</button>}
					{missing.why === "branch" && <button className="btn ghost small" onClick={() => void navigator.clipboard?.writeText(missing.entry)}>Copy entry ID</button>}
					<button className="btn ghost small" onClick={() => setMissing(undefined)}>
						Dismiss
					</button>
				</div>
			)}
			<div className={rail.layout ? "transcript-frame strip" : "transcript-frame"}>
			{find.open && find.filter && <FindFiltered find={find} outline={outline.outline} />}
			<div
				className="scroll"
				hidden={find.open && find.filter}
				data-region="transcript"
				data-end-band={END_BAND}
				tabIndex={-1}
				onKeyDown={(event) => {
					// G goes to the newest end, past a frozen window's bottom.
					if (event.key === "G" && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target) && (event.target as HTMLElement).closest(".scroll, .panel-body, [data-scrollable]") === event.currentTarget) {
						event.preventDefault();
						event.stopPropagation();
						toEnd();
						return;
					}
					// [ and ] step through prompts, like the prompt header's ‹ ›.
					if ((event.key === "[" || event.key === "]") && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
						const step = event.currentTarget.parentElement?.querySelector<HTMLAnchorElement>(`.prompt-head [data-prompt-step="${event.key === "[" ? "prev" : "next"}"][href]`);
						if (step) { event.preventDefault(); step.click(); return; }
					}
					handleRegionScrollKey(event);
					if (event.key === "i" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && focusIntent("insert")) event.preventDefault();
				}}
				ref={scroller}
				onWheel={keepPlace.onWheel}
				onScroll={(e) => {
					const el = e.currentTarget;
					keepPlace.onScroll();
					noteAway();
					if (el.scrollTop < 600 && !restore.current) growWindow();
					if (el.scrollHeight - el.scrollTop - el.clientHeight < 600 && !restore.current) growBelow();
					savePlace();
				}}
			>
				<RevealScope.Provider value={revealScope}>
				<div className="transcript">
					{view === undefined ? (
						<div className="empty">{error ?? "Loading…"}</div>
					) : (
						<>
							{(view.hiddenBefore || older.length > 0) && olderMore && (
								<div style={{ textAlign: "center" }}>
									<button className="btn small" onClick={() => void loadOlder()}>
										{reader ? "Read an earlier page" : "Show earlier messages (before the active context)"}
									</button>
								</div>
							)}
							{older.length > 0 && (
								<>
									<Entries entries={reader ? older.filter((e) => !shown.some((v) => v.id === e.id)) : older} live={NO_LIVE} host={host} threadId={threadId} onOpenConversation={openConversation} canFork={!pi} lens={lens} closed={Boolean(summary?.closed)} reveal={jump?.threadId === threadId ? jump : undefined} />
									<div className="compaction">{reader ? "Newest messages below · intermediate entries may be omitted" : "The model's active context starts below"}</div>
								</>
							)}
							{view.entries.length === 0 && !busy && <div className="empty">Send a message to start.</div>}
							{segments(shown, omitted.current, head.current).map((part, i, parts) => (
								<Fragment key={part.key}>
									{i > 0 && <div className="omitted">Some entries after this one were never shown here. ↓ new goes to the newest.</div>}
									<Entries entries={part.rows} live={view.live} host={host} threadId={threadId} onOpenConversation={openConversation} canFork={!pi} lens={lens} busy={i === parts.length - 1 && tailPainted() && busy} closed={Boolean(summary?.closed)} reveal={jump?.threadId === threadId ? jump : undefined} />
								</Fragment>
							))}
							{/* Live output belongs after the newest entry; a frozen window ends earlier. */}
							{tailPainted() && <LivePartial live={view.live} />}
							{busy && tailPainted() && !(view.live as Any)?.generation?.message && !((view.live as Any)?.tools ?? []).some((t: Any) => t.status !== "done") && (
								<div className="status-line">
									<span className="spinner" /> {ACTIVITY_LABEL[summary?.activity ?? "thinking"]}…
								</div>
							)}
							{summary?.lastError && !busy && !lastEntryShows(view.entries, summary.lastError) && <ModelError host={host} text={summary.lastError} prefix="The last run failed" />}
						</>
					)}
				</div>
				</RevealScope.Provider>
				<div className="new-below" role="status">
					{/* A reader away from the end cannot see live output: the status row says the thread is still working. */}
					{fresh ? (
						<button className="btn small" title="Go to the newest entry and follow" onClick={toEnd}>{newBelowLabel(fresh)}{away && busy ? " · working…" : ""}</button>
					) : (
						away && busy && <span className="note">working…</span>
					)}
				</div>
			</div>
			{reader && <PromptHeader host={host} threadId={threadId} state={outline} place={promptPlace} />}
			{rail.layout && <CompanionScrollbar host={host} threadId={threadId} state={outline} place={promptPlace} scroller={scroller} layout={rail.layout} strip={rail.strip} />}
			</div>
			{summary && attentionOf(summary).length > 0 && (
				// Why the sidebar marks this Session with "!", said where the owner acts on it.
				<div className="attn-note" role="status">
					{attentionOf(summary).map((a, i) => (
						<div key={i}>
							<strong>{a.source === "Herdr" ? "The pane is waiting for input" : a.source === "error" ? "The last turn failed" : `${a.source} says it needs you`}</strong>
							<span>{a.source === "Herdr" ? " · answer in the composer, or open the pane in Herdr" : ` · ${a.reason}`}</span>
						</div>
					))}
				</div>
			)}
			{pi && PI_BANDS.map((Band, i) => <Band key={i} host={host} threadId={threadId} lens={lens} />)}
			{view && !summary?.closed && (!pi || summary?.control) && <QuoteSelection key={`${host}/${threadId}`} onQuote={(text, note) => composer.current?.quote(text, note)} transcript={scroller} />}
			{view && <Composer composerRef={composer} host={host} threadId={threadId} view={view} summary={summary} models={models} actions={{ panel, openPanel: setPanel }} pi={pi} />}
		</div>
	);
}
