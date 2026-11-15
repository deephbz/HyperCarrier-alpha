// The durable thread surface (shell-slots.ts ThreadSurface): Fork, user images, compaction records, raw exports, the
// archive header and menu, rename, model sign-in, quotes and the node panels. Registered in extensions-ui.ts.

import { useEffect, useState } from "react";
import type { TeamValue } from "../../../src/shared/team.ts";
import { noticeMessage } from "../../../src/shared/team-origin.ts";
import { hub } from "../client.ts";
import { useKeyAction } from "../keymap.ts";
import { go, MOD } from "../util.ts";
import { openAccounts } from "../components/Accounts.tsx";
import { ChangesPanel } from "../components/ChangesPanel.tsx";
import { CompactionRow, useCompactRecords } from "../components/CompactionRow.tsx";
import { draftCustody, setDraftCustody } from "../components/Composer.tsx";
import { newId } from "../ids.ts";
import { InfoPanel } from "../components/Panel.tsx";
import { Messages } from "../views/team/Messages.tsx";
import type { CompactionRowProps, EntryActionProps, TeamMode, ThreadHeaderProps, ThreadSurface, UserImagesProps } from "../shell-slots.ts";
import { ArchiveThreadDialog } from "./archive-dialog.tsx";
import { DURABLE_COMPOSER } from "./composer-surface.tsx";
import { carriedDraft } from "./drafts.ts";
import "./team-messages.css";

/** A fork of a closed thread continues its unsent draft; the source keeps its copy, and a draft in the fork wins. */
function carryDraft(host: string, from: string, to: string): void {
	const carried = carriedDraft(draftCustody(host, from), draftCustody(host, to), newId);
	if (carried) setDraftCustody(host, to, carried);
}

/** Fork a new thread from a user message; a closed thread's unsent draft goes with it. */
function ForkAction({ host, threadId, entry, closed }: EntryActionProps) {
	const fork = async () => {
		const { threadId: forked } = await hub.request(host, "thread.fork", { threadId, entryId: entry });
		if (closed) carryDraft(host, threadId, forked);
		go(host, forked);
	};
	return (
		<button className="btn ghost small" title="Fork a new thread from this message" onClick={() => void fork()}>
			Fork
		</button>
	);
}

const imageCache = new Map<string, Promise<{ data: string; mimeType: string }[]>>();

/** Images in a user message, fetched on demand: the transcript replica carries only their count. */
function UserImages({ host, threadId, entryId, count }: UserImagesProps) {
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

/** A compaction row with the node's compaction record: method, figures and the tool outputs kept verbatim. */
function RecordedCompaction({ entry, host, threadId, fragment, compactions, more }: CompactionRowProps) {
	const records = useCompactRecords(host, threadId, compactions);
	return <CompactionRow entry={entry} record={records.find((r) => r.taskId !== undefined && r.taskId === entry.byTaskId)} host={host} threadId={threadId} fragment={fragment} more={more} />;
}

/**
 * The archive chord and its Undo toast, and the Archived badge. The chord and the palette archive an idle thread at once
 * and offer Undo; a working thread or a Team lead confirms first. The badge is the one live status.
 */
function ArchiveHeader({ host, threadId, summary, hostState, close }: ThreadHeaderProps) {
	const [archivedToast, setArchivedToast] = useState(false);
	useEffect(() => { if (archivedToast) { const timer = setTimeout(() => setArchivedToast(false), 6000); return () => clearTimeout(timer); } }, [archivedToast]);
	useEffect(() => setArchivedToast(false), [host, threadId]);
	useKeyAction("archive", !hostState?.buildMismatch && summary && summary.team?.role !== "worker" ? (event) => {
		event.preventDefault();
		if (summary.archived) void hub.request(host, "thread.archive", { threadId, archived: false });
		else if (summary.activity === "idle" && summary.team?.role !== "lead") void hub.request(host, "thread.archive", { threadId, archived: true }).then(() => setArchivedToast(true), () => {});
		else close();
	} : undefined);
	return <>
		{archivedToast && <div className="toast">Archived · <button className="link-button" onClick={() => { setArchivedToast(false); void hub.request(host, "thread.archive", { threadId, archived: false }); }}>Undo</button></div>}
		{summary?.archived && <div className="badge" role="status">Archived · <button className="link-button" disabled={hostState?.buildMismatch} title={hostState?.buildMismatch ? "This node needs the new build" : undefined} onClick={() => void hub.request(host, "thread.archive", { threadId, archived: false })}>Unarchive</button></div>}
	</>;
}

/** More menu items while the thread is live: a new thread beside it, and Archive. */
function ArchiveMenu({ host, threadId, summary, hostState, close }: ThreadHeaderProps) {
	if (!summary) return null;
	return <>
		<button title={`Start a thread after this one, in its tab (${MOD}N)`} onClick={() => window.dispatchEvent(new Event("ampi:new"))}>
			New thread beside
		</button>
		{summary.team?.role === "worker" ? <button disabled title="The lead manages Workers">Archive thread</button> : <button disabled={hostState?.buildMismatch} title={hostState?.buildMismatch ? "This node needs the new build" : "Stop owned work and put this thread away"} onClick={() => summary.activity === "idle" && summary.team?.role !== "lead" ? void hub.request(host, "thread.archive", { threadId, archived: true }) : close()}>Archive thread</button>}
	</>;
}

export const durableThread: ThreadSurface = {
	entryAction: ForkAction,
	userImages: UserImages,
	compactionRow: RecordedCompaction,
	rawExport: (entry) => entry.rawExport,
	// An older node's entry (a thread the hub holds no copy of) carries its text and data but no projected message.
	noticeMessage: (entry) => {
		const { text, data } = entry as { text?: unknown; data?: unknown };
		return noticeMessage(entry.entryKind, data, typeof text === "string" ? text : "");
	},
	header: ArchiveHeader,
	menuItems: ArchiveMenu,
	closeDialog: ArchiveThreadDialog,
	rename: (host, threadId, title) => void hub.request(host, "thread.rename", { threadId, title }),
	signIn: openAccounts,
	canQuote: () => true,
	composer: DURABLE_COMPOSER,
	panels: [
		{ name: "changes", label: "Changes", component: ChangesPanel, wide: true },
		{ name: "info", label: "Info", component: InfoPanel },
	],
};

type Team = TeamValue["teams"][number];

/** A Team's message records beside Tasks; a Host that publishes none says so. */
function TeamMessages({ team }: { team: Team; host: string }) {
	const messages = team.messages ?? { availability: "unavailable" as const, reason: "Messages unavailable: this Host does not publish message records." };
	return <Messages key={messages.availability === "available" ? JSON.stringify([messages.source, messages.epoch]) : "unavailable"} value={messages} />;
}

export const MESSAGES_MODE: TeamMode = { key: "messages", label: "Messages", component: TeamMessages };
