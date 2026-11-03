// Owner-facing text for Arc facts. The service owns acceptance, recovery and warning persistence.
import { useEffect, useState } from "react";
import type { ArcService, ArcValue, BuildRecord, RequestOutcome } from "../../../../src/shared/arc.ts";
import { clock, href } from "../../util.ts";

export const PAUSE = "Automatic Builds paused: the last Build stopped during a model call that may have been charged. Press Build to continue (it may charge again).";

export function requestText(request: RequestOutcome | undefined, host: string, service?: ArcService): string | undefined {
	if (!request || request.outcome === "accepted") return;
	if (request.outcome === "unknown") return request.waitFor === "service" && service?.state !== "unreachable"
		? `Build request status unknown. AmPi sends it again when the Arc service on ${host} is ready.`
		: `Build request status unknown. AmPi sends it again when ${host} reconnects.`;
	if (request.outcome === "not-sent") return `${host} is not reachable. The Arc cannot build now.`;
	if (request.code === "id-conflict") return "Build request conflicted with an earlier one. Press Build again.";
	if (request.code === "service") return service?.state === "running" ? undefined : `Build request refused. ${service ? serviceText(service) : request.detail ?? `The Arc service on ${host} cannot accept Builds now.`}`;
	const reasons = { paused: "Automatic Builds are paused.", settings: `Arc settings on ${host} are invalid.`, source: `The Session file on ${host} cannot be read now.`, invalid: "The request is invalid." };
	return `Build request refused. ${reasons[request.code]}`;
}

export function failureText(error: BuildRecord["error"], host: string): string {
	if (error?.code === "model-mismatch") return "Build result is uncertain: the model that answered differs from the setting.";
	const reasons = { "model-mismatch": "", "sign-in": `no sign-in for the Arc model on ${host}`, quota: "model quota reached", model: "the model call failed", answer: "the model's answer could not be used", settings: `Arc settings on ${host} are invalid`, source: `the Session file on ${host} cannot be read now`, internal: "" };
	return error && reasons[error.code] ? `Build failed: ${reasons[error.code]}.` : "Build failed.";
}

function serviceText(service: ArcService): string {
	if (service.state === "stopping") return `${service.host}: Arc service is stopping for every client. A linked hub restarts it within seconds.`;
	if (service.state === "unreachable") return `${service.host}: Host is unreachable since ${clock(Date.parse(service.since))}. Check the SSH connection, then run ampi arc status --host ${service.host}.`;
	if (service.text) return service.text;
	const host = service.host;
	switch (service.state) {
		case "cannot-start": return `${host}: Arc service cannot start: ${service.prerequisite} missing`;
		case "no-sign-in": return `${host}: Arc service has no sign-in for ${service.model}. Sign in using ${service.path}.`;
		case "invalid-settings": return `${host}: Arc service settings are invalid: ${service.path}, ${service.key}.`;
		case "running": return `${host}: Arc service running${service.version ? ` · version ${service.version}` : ""}.`;
		case "fault": return `${host}: Arc service stopped Builds after an internal error. Run ampi arc stop --host ${host} to restart it; a linked hub starts it again within seconds.`;
		case "busy": return `${host}: Arc service holds its lock but does not answer. Run ampi arc status --host ${host} before retrying.`;
		case "error": return `${host}: Arc maintenance failed. Query status before retrying.`;
		case "not-configured": return `${host}: not in hub.json.`;
		case "updating": return `${host}: Arc service updating.`;
		case "stopped": return `${host}: Arc service is stopped. A linked hub restarts it within seconds.`;
	}
}

export function ServiceLines({ services }: { services?: ArcService[] }) {
 return <>{services?.filter(s => s.state !== "running").map(service => <div className="arc-service arc-meta" key={service.host}><p>{serviceText(service)}</p></div>)}</>;
}

export function BuildState({ value, stale, host }: { value: ArcValue; stale: boolean; host: string }) {
	const status = value.status;
	const wait = status.wait;
	let text: string | undefined;
	if (status.pause === "uncertain-call" || status.state === "uncertain") text = PAUSE;
	else if (status.state === "waiting") {
		if (status.waitCause === "capacity" || wait?.reason === "capacity") text = wait ? `Waiting for a model slot: ${wait.running} of ${wait.limit} in use${wait.byHost?.length ? ` (${wait.byHost.map(({ host, running }) => `${host} ${running}`).join(", ")})` : ""}.` : "Waiting for a model slot.";
		else if (status.waitCause === "admission-unavailable") text = "Waiting: AmPi cannot check the shared model limit now.";
		else if (status.waitCause === "source-unavailable") text = `Waiting: the Session file on ${host} cannot be read now.`;
		else if (status.waitCause === "survivor") text = `Waiting for an earlier model process on ${host} to end.`;
	}
	const detail = status.record?.error?.message ?? status.error?.message ?? status.detail;
	return <>
		{text && <p className="arc-meta" role="status">{text}</p>}
		{status.elapsedMs !== undefined && status.state === "building" && <p className="arc-meta"><BuildElapsed value={value} stale={stale} /></p>}
		{detail && <details className="arc-meta"><summary>Build details</summary><p>{detail}</p></details>}
	</>;
}

function BuildElapsed({ value, stale }: { value: ArcValue; stale: boolean }) {
	const status = value.status;
	const key = `${status.buildId}:${status.observedAt}:${status.elapsedMs}`;
	const [sample, setSample] = useState(() => ({ key, at: performance.now() }));
	const [now, setNow] = useState(() => performance.now());
	if (sample.key !== key) setSample({ key, at: performance.now() });
	useEffect(() => {
		if (stale) return;
		setNow(performance.now());
		const timer = setInterval(() => setNow(performance.now()), 1000);
		return () => clearInterval(timer);
	}, [stale, key]);
	const ms = (status.elapsedMs ?? 0) + (sample.key === key ? Math.max(0, now - sample.at) : 0);
	const seconds = Math.floor(ms / 1000);
	return <span className="arc-elapsed">Elapsed {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}{stale && <> · as of {status.observedAt ? clock(Date.parse(status.observedAt)) : "last update"}</>}</span>;
}

export type DismissFailure = { id: string; toPosition: number; message: string };

export function DropLines({ value, host, threadId, dismiss, dismissing, dismissFailure, needsYou }: { value: ArcValue; host: string; threadId: string; dismiss?: (id: string, toPosition: number) => void; dismissing?: { id: string; toPosition: number }[]; dismissFailure?: DismissFailure; needsYou: boolean }) {
	const drops = value.receipt?.drops?.filter((drop) => drop.needsYou === needsYou) ?? [];
	return <>{drops.map((drop) => <div className="arc-drop arc-meta" key={drop.id}>
		<p>A recent Build could not add {drop.kind === "unknown" ? "an item" : `a ${drop.kind}`} from messages {drop.fromPosition}–{drop.toPosition}. <a href={href.thread(host, threadId, { entry: drop.from, panel: "arc" })}>Read source</a>. {value.canDismiss && dismiss && <button className="btn small" disabled={dismissing?.some((d) => d.id === drop.id && d.toPosition === drop.toPosition)} onClick={() => dismiss(drop.id, drop.toPosition)} aria-label={`Dismiss warning: ${drop.title}`}>{dismissing?.some((d) => d.id === drop.id && d.toPosition === drop.toPosition) ? "Dismissing…" : "Dismiss"}</button>}</p>
		{dismissFailure?.id === drop.id && dismissFailure.toPosition === drop.toPosition && <p role="alert">{dismissFailure.message}</p>}
		<details><summary>{drop.title}</summary><p>{drop.reason}</p></details>
	</div>)}</>;
}
