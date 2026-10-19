// One rule for a tool call's state, from transcript evidence alone. The transcript, the Overview's Running-now
// reason and any other place that shows a call without its result use it. Live tool slots only add output:
// Pi Sessions send none, so the state never depends on them.

/** `unfinished`: the call is still open, but the Session is not running a turn. */
export type ToolCallState = "done" | "failed" | "running" | "interrupted" | "unfinished";

/**
 * `open`: the call has no result, its entry did not stop as aborted, and no later turn follows it (see OpenCalls).
 * A missing result alone proves nothing; a call that is no longer open and has no result was interrupted.
 */
export function toolCallState({ result, open, active }: { result?: { isError: boolean }; open: boolean; active: boolean }): ToolCallState {
	if (result) return result.isError ? "failed" : "done";
	if (!open) return "interrupted";
	return active ? "running" : "unfinished";
}

/** The part of a transcript entry that opens or closes calls. A UiEntry fits: user, assistant and tool-result. */
export type CallEvidence = { kind: string; stop?: string; blocks?: readonly { type: string; callId?: string }[]; callId?: string };

/** Tracks the open calls while entries arrive in transcript order. Only calls of the last turn can be open. */
export class OpenCalls {
	readonly ids = new Set<string>();

	add(entry: CallEvidence): void {
		if (entry.kind === "tool-result") this.ids.delete(entry.callId ?? "");
		else if (entry.kind === "user" || entry.kind === "assistant") {
			// A later turn closes every earlier call that has no result yet.
			this.ids.clear();
			if (entry.stop !== "aborted") for (const block of entry.blocks ?? []) if (block.type === "tool" && block.callId) this.ids.add(block.callId);
		}
	}
}

export function openCalls(entries: Iterable<CallEvidence>): Set<string> {
	const open = new OpenCalls();
	for (const entry of entries) open.add(entry);
	return open.ids;
}
