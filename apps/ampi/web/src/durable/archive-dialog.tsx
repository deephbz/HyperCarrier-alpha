// The durable thread's Archive dialog: the close action of a durable Host kind.

import { useState } from "react";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { hub, useTopic } from "../client.ts";
import { Modal } from "../components/Modal.tsx";

/** Archive stops the thread's work and puts it away; its history stays readable. */
export function ArchiveThreadDialog({ host, summary, onClose }: { host: string; summary: ThreadSummary; onClose: () => void }) {
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const teamId = summary.team?.role === "lead" ? summary.team.teamId : undefined;
	const { value: team } = useTopic(host, teamId ? { kind: "team", teamId } : undefined);
	const workerCount = team?.workers?.filter((worker: { membership: { active: boolean } }) => worker.membership.active).length;
	const archive = async () => {
		setBusy(true);
		setError(undefined);
		try {
			if (summary.activity !== "idle") await hub.request(host, "thread.abort", { threadId: summary.id });
			await hub.request(host, "thread.archive", { threadId: summary.id, archived: true });
			onClose();
		} catch (e) {
			setError((e as Error).message);
			setBusy(false);
		}
	};
	return <Modal onClose={onClose}>
		<h2>{summary.activity === "idle" ? `Archive ${summary.title}?` : "This thread is working. Stop it and archive?"}</h2>
		<p>Archive stops this thread's work and puts it away. Its history stays readable. You can unarchive it or send a message to continue.</p>
		{teamId && <p>{workerCount === undefined ? "Archiving also ends its Team and archives its Workers." : `Archiving also ends its Team and archives ${workerCount} ${workerCount === 1 ? "Worker" : "Workers"}.`}</p>}
		{error && <div className="err-box" role="alert">{error}</div>}
		<div className="actions"><button className="btn" disabled={busy} onClick={onClose}>Cancel</button><button className="btn danger" disabled={busy} onClick={() => void archive()}>{busy ? "Archiving…" : summary.activity === "idle" ? "Archive" : "Stop and archive"}</button></div>
	</Modal>;
}
