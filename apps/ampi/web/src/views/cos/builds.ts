// One wording for a recorded Arc Build, shared by the Arc page and the Rarebit view's row.

import type { ArcBuildRun, ArcErrorCode, ArcValue } from "../../../../src/pi/views/cos-arc.ts";
import { money } from "../../util.ts";

/** "Arc updated automatically · 6 calls (1 retry) · $0.03", or the failure, from one Build log record. */
export function buildText(b: ArcBuildRun): string {
	const what = b.state === "done" ? (b.trigger === "auto" ? "Arc updated automatically" : "Arc built on request") : b.trigger === "auto" ? "Automatic Arc update failed" : "Arc build failed";
	const reused = b.reusedLabels ? ` · ${b.reusedLabels} label${b.reusedLabels === 1 ? "" : "s"} reused` : "";
	const retried = b.retries ? ` (${b.retries} retr${b.retries === 1 ? "y" : "ies"})` : "", gaps = b.unlabelledChunks ? ` · ${b.unlabelledChunks} chunk${b.unlabelledChunks === 1 ? "" : "s"} unlabelled` : "";
	return `${what} · ${b.calls} call${b.calls === 1 ? "" : "s"}${retried} · ${b.usage.cost === null ? "price unavailable" : money(b.usage.cost)}${reused}${gaps}`;
}

/** Tooltip detail: model, tokens, and the error when there is one. */
export function buildDetail(b: ArcBuildRun): string {
	return [`${new Date(b.startedAt).toLocaleString()} · ${b.model ?? "model unknown"}`, `${b.usage.input.toLocaleString()} input · ${b.usage.output.toLocaleString()} output tokens`, b.error ?? ""].filter(Boolean).join("\n");
}

/** Running Build progress: "2 / 3 calls · 2 of 21 chunks to label · Reading chunk evidence with the model…". */
export function progressText(job: NonNullable<ArcValue["job"]>): string {
	return `${job.done} / ${job.total} calls · ${job.toLabel} of ${job.chunks} chunks to label · ${job.waitingFor ?? "Reading chunk evidence with the model…"}`;
}

/** What failed, by error code; a request that never started a Build has no code. */
export function failurePrefix(code: ArcErrorCode | undefined): string {
	switch (code) {
		case "model": return "The model call failed.";
		case "answer": return "The model’s answer was unusable.";
		case "source": return "The Session changed while Build arc read it.";
		default: return "Build arc failed.";
	}
}

/** The next action for a failed Build. Only a model failure points at Pi's model configuration. */
export function failureHint(code: ArcErrorCode | undefined): string {
	switch (code) {
		case "model": return "Check Pi’s model configuration on the hub, then retry Build arc.";
		case "source": return "Retry Build arc; it reads the Session again.";
		default: return "Retry Build arc.";
	}
}

/** "≈12,000 input tokens · 3 calls · synthesis rereads the whole Session · last Build: 11,800 input tokens". */
export function estimateText(e: ArcValue["buildEstimate"]): string {
	const last = e.lastInputTokens ? ` · last Build: ${e.lastInputTokens.toLocaleString()} input tokens` : "";
	return `≈${e.inputTokens.toLocaleString()} input tokens · ${e.calls} calls · synthesis rereads the whole Session${last}`;
}
