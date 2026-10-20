// One wording for a recorded Arc Build, shared by the Arc page and the Rarebit view's row.

import type { ArcBuildRun, ArcErrorCode, ArcFailure, ArcValue } from "../../../../src/pi/views/cos-arc.ts";
import { money } from "../../util.ts";
import { dateTime } from "./data.tsx";

/** "Arc updated automatically · 6 calls (1 retry) · $0.03 · claude-haiku-5-5", or the failure, from one Build log record. */
export function buildText(b: ArcBuildRun): string {
	// A done Build below the floor stored nothing, so its row never says built.
	if (b.empty) return `Nothing to summarize yet · ${b.calls} call${b.calls === 1 ? "" : "s"} · ${b.usage.cost === null ? "price unavailable" : money(b.usage.cost)}`;
	const what = b.state === "done" ? (b.trigger === "auto" ? "Arc updated automatically" : "Arc built on request") : b.trigger === "auto" ? "Automatic Arc update failed" : "Arc build failed";
	const reused = b.reusedLabels ? ` · ${b.reusedLabels} label${b.reusedLabels === 1 ? "" : "s"} reused` : "";
	const retried = b.retries ? ` (${b.retries} retr${b.retries === 1 ? "y" : "ies"})` : "", gaps = b.unlabelledChunks ? ` · ${b.unlabelledChunks} chunk${b.unlabelledChunks === 1 ? "" : "s"} unlabelled` : "";
	// Labels and synthesis may run on different models; the row names each once, the tooltip gives provider/id.
	const names = b.models ? [...new Set([b.models.labels, b.models.synthesis].map((m) => m.split("/").pop()))] : b.model ? [b.model.split("/").pop()] : [];
	// A failed model check names the requested model as written, as its error does.
	const model = b.missingModel ? ` · ${b.missingModel} not found` : names.length ? ` · ${names.join(" + ")}` : "";
	const calls = b.calls ? `${b.calls} call${b.calls === 1 ? "" : "s"}${retried} · ${b.usage.cost === null ? "price unavailable" : money(b.usage.cost)}` : `no model calls · ${money(0)}`;
	return `${what}${b.cause ? ` · ${b.cause}` : ""} · ${calls}${reused}${gaps}${model}`;
}

/** Where each Arc step's model is set; the Build button and the Build tooltip both say it. */
export const MODEL_KEYS = "Labels use models.arcLabels; the Arc (synthesis and context) uses models.arcSynthesis.";

/** Tooltip detail: the model and price per call purpose, tokens, and the error when there is one. */
export function buildDetail(b: ArcBuildRun): string {
	// An ask command (demo, tests, other carriers) reports no usage; zero tokens over real calls means "not reported".
	const u = b.usage, reported = !b.calls || u.input || u.output || u.cacheRead || u.cacheWrite;
	const usage = reported ? `${u.input.toLocaleString()} input · ${u.cacheRead.toLocaleString()} cache read · ${u.cacheWrite.toLocaleString()} cache write · ${u.output.toLocaleString()} output tokens` : "usage not reported";
	// Records before the two-step Build also name a separate context call.
	const purposes = b.models ? (["labels", "synthesis", "context"] as const).filter((p) => b.models![p]).map((p) => {
		const n = b.usageByPurpose?.[p];
		// Only the reduced step-2 input is named; the full evidence is the default.
		const evidence = p === "synthesis" && b.arcEvidence === "labels" ? " · evidence: owner turns only (hub.json arcEvidence)" : "";
		return `${p}: ${b.models![p]}${n ? ` · ${n.calls} call${n.calls === 1 ? "" : "s"} · ${n.cost === null ? "price unavailable" : money(n.cost)}` : ""}${evidence}`;
	}).concat(MODEL_KEYS) : [];
	// `models` names each purpose's provider/id; `model`, the last answering model, names only older records.
	const head = b.models ? "models per purpose:" : b.missingModel ? `no model named ${b.missingModel}` : b.model ?? (b.calls ? "model unknown" : "no model calls");
	return [`${new Date(b.startedAt).toLocaleString()} · ${head}`, ...purposes, usage, b.error ?? ""].filter(Boolean).join("\n");
}

/** Running Build progress by step: "Labelling 6 of 21 chunks… · 1 / 5 calls", then "Writing the Arc… · 4 / 5 calls". */
export function progressText(job: NonNullable<ArcValue["job"]>): string {
	// A Build that waits for its Session to load or for the model check has no step yet; only the wait is news.
	if (!job.step) return job.waitingFor ?? "Starting Build arc…";
	const step = job.step === "labels" ? `Labelling ${job.labelled ?? 0} of ${job.toLabel} chunk${job.toLabel === 1 ? "" : "s"}…` : "Writing the Arc…";
	return `${step} · ${job.done} / ${job.total} calls${job.waitingFor ? ` · ${job.waitingFor}` : ""}`;
}

/**
 * The last Build's failure: the job's, else the newest Build record's, so it survives a hub restart. A running Build
 * shows no failure. `role` is "alert" for a failure of this hub run and "status" for one read from the history.
 */
export function lastFailure(v: Pick<ArcValue, "job" | "builds">): { failure: ArcFailure; role: "alert" | "status" } | null {
	if (v.job?.state === "running") return null;
	if (v.job?.lastError) return { failure: v.job.lastError, role: "alert" };
	const b = v.builds?.at(-1);
	return b?.state === "error" && b.error ? { failure: { message: b.error, code: b.errorCode ?? "internal", purpose: b.errorPurpose, model: b.errorModel ?? null, at: b.endedAt }, role: "status" } : null;
}

/**
 * The failed Build line: what failed, the call and model whose reply stayed invalid, when, and which Arc shows.
 * `keptAt` is when the shown Arc was built (ArcValue.keptAt), or null when no valid Arc shows. `retry` (labelRetry)
 * replaces the generic next action of a label failure: its message already states the gap.
 */
export function failureText(f: ArcFailure, keptAt: string | null, retry = ""): string {
	const at = ` · ${new Date(f.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	const stays = keptAt ? ` Showing the Arc built at ${dateTime(keptAt)}.` : "";
	const model = f.model ? ` · ${f.model.split("/").pop()}` : "";
	if (retry) return `${f.message.replace(/\.$/, "")}${model}${at}.${stays} ${retry}`;
	// A failed model check made no call. A name that names no model carries its own fix, which replaces the generic one.
	if (f.hint) return `${f.message.replace(/\.$/, "")}${at}. ${f.hint}${stays}`;
	if (f.preflight) return `Build arc made no model call. ${f.message.replace(/\.$/, "")}${at}.${stays} ${failureHint(f.code)}`;
	return `${failurePrefix(f.code)} ${f.message.replace(/\.$/, "")}${model}${at}.${stays} ${failureHint(f.code)}`;
}

/** What failed, by error code; a request that never started a Build has no code. */
export function failurePrefix(code: ArcErrorCode | undefined): string {
	switch (code) {
		case "model": return "The model call failed.";
		case "answer": return "The model’s answer was unusable.";
		case "source": return "Build arc could not load the whole Session.";
		default: return "Build arc failed.";
	}
}

/** The next action for a failed Build. Only a model failure points at Pi's model configuration. */
export function failureHint(code: ArcErrorCode | undefined): string {
	switch (code) {
		case "model": return "Check Pi’s model configuration on the hub, then retry Build arc.";
		case "source": return "Retry Build arc in a few minutes.";
		case "answer": return "Retry Build arc; it asks the same model again.";
		default: return "Retry Build arc.";
	}
}

/**
 * "≈12,000 input tokens · 3 calls · synthesis rereads the whole Session · last Build: 11,800 input tokens, $0.04".
 * A last Build whose model reported no usage reads "last Build: price unavailable".
 */
export function estimateText(e: ArcValue["buildEstimate"]): string {
	const price = e.lastCost === null || e.lastCost === undefined ? "price unavailable" : money(e.lastCost);
	const last = e.lastInputTokens === null || e.lastInputTokens === undefined ? " · dollar price unavailable"
		: ` · last Build: ${e.lastInputTokens ? `${e.lastInputTokens.toLocaleString()} input tokens, ` : ""}${price}`;
	return `≈${e.inputTokens.toLocaleString()} input tokens · ${e.calls} calls · synthesis rereads the whole Session${last}`;
}

/**
 * What Build arc labels after a label failure (the last Build record left chunks unlabelled), or "" for any other
 * failure. With a kept Arc it labels the chunks that Arc lacks, a grown last chunk included; without one, all chunks.
 */
export function labelRetry(f: ArcFailure, v: Pick<ArcValue, "builds" | "coverage" | "keptAt">): string {
	const b = v.builds?.at(-1);
	if (f.purpose !== "label" || b?.state !== "error" || !b.unlabelledChunks) return "";
	const all = v.coverage.labelledChunks + v.coverage.unmappedChunks, n = v.keptAt ? b.freshChunks ?? v.coverage.unmappedChunks : all;
	return v.keptAt ? `Build arc labels the ${n} new or changed chunk${n === 1 ? "" : "s"}.` : `Build arc labels all ${n} chunk${n === 1 ? "" : "s"}.`;
}

/** Why automatic Builds wait after the same chunks failed to label twice (ArcValue.stuck), and what unlocks them. */
export function stuckText(v: Pick<ArcValue, "stuck">): string {
	if (!v.stuck) return "";
	const n = v.stuck.chunks.length, unlock = v.stuck.until === "messages" ? "Automatic Builds wait for new messages" : "Automatic Builds stop until Build arc succeeds or AmPi updates";
	return `${n === 1 ? "Chunk" : `${n} chunks`} ${v.stuck.chunks.join(", ")} failed to label in the last 2 Builds. ${unlock}; Build arc retries them now.`;
}
