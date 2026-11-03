import type { Outcome } from "./composer-drafts.ts";

type Failure = { code?: string; message: string };

/** Only a proven refusal releases a send's key. Transport errors and new codes keep it. */
const FINAL_REFUSAL = new Set([
	"bad_request", // packages/pi-hc-control/src/control.mjs:command; src/pi/remote-agent.cjs.
	"bad_args", // packages/pi-hc-control/src/control.mjs built-ins.
	"unsupported", // components/Composer.tsx:hostCommand, before dispatch; src/pi/host.ts ops a Pi Session does not serve.
	"version_skew", // src/shared/skew.ts VERSION_SKEW: a page or a pi-hc-control of another build; refused before any send.
	"unsupported_command", // packages/pi-hc-control/src/control.mjs:runCommand; src/pi/remote-agent.cjs:commandKeys.
	"unknown_command", // packages/pi-hc-control/src/control.mjs:runCommand; src/pi/remote-agent.cjs:commandKeys.
	"no_control", // src/pi/host.ts:#slash (list); src/pi/remote-agent.cjs:viaCommandControl, before any send.
	"editor_not_empty", // src/pi/remote-agent.cjs:viaKeys reads the pane before it types.
	"needs_control", // src/pi/remote-agent.cjs:viaKeys and spawn refuse slash text as a message before any keys.
	"command_choice", // components/Composer.tsx:hostCommand offers a choice without sending.
	"busy", // packages/pi-hc-control/src/control.mjs:builtin.compact, before abort/compact.
	"busy_compacting", // packages/pi-hc-control/src/control.mjs:submit/runCommand refuse before delivery.
]);

/** Non-send failures can also carry the hub's raw link key. */
export function hostErrorMessage(error: Failure, hostLabel: string): string {
	return error.code === "host_disconnected" ? `${hostLabel} did not answer.` : error.message;
}

/** A proven refusal, or one the composer makes before it sends anything. */
export function refusalText(message: string): string {
	return `Not sent: ${message.trimEnd().replace(/\.+$/, "")}. Your draft is kept; fix it and send again.`;
}

/**
 * One result controls the retry key and its explanation for messages and typed commands. Only a proven refusal is
 * certain. PiHost's message route does not forward the requestId, so no retry is promised exactly once.
 */
export function sendOutcome(error: Failure, hostLabel: string): Outcome {
	if (FINAL_REFUSAL.has(error.code ?? "")) return { uncertain: false, text: refusalText(error.message) };
	return { uncertain: true, text: `${hostLabel} did not answer. Your message is back in the composer. Check the Pi pane before sending again; it may already have arrived.` };
}
