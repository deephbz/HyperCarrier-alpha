import type { Outcome } from "./composer-drafts.ts";

type Failure = { code?: string; message: string };

/** Only a proven refusal releases a send's key. Transport errors and new codes keep it. */
const FINAL_REFUSAL = new Set([
	"key_conflict", // src/node/submit-keys.ts:claimSubmitKey; src/node/commands.ts:runCommand.
	"command_expired", // src/node/commands.ts:runCommand refuses a retired key before any effect.
	"bad_request", // src/node/server.ts validation; src/node/commands.ts:runCommand; packages/pi-hc-control/src/control.mjs:command.
	"bad_args", // src/node/commands.ts:execute; packages/pi-hc-control/src/control.mjs built-ins.
	"unsupported", // src/node/server.ts op dispatch; components/Composer.tsx:hostCommand, before dispatch; src/pi/host.ts thread.submit (an older page's slash text). Older pages know this code: keep it.
	"unsupported_command", // src/node/commands.ts:execute; packages/pi-hc-control/src/control.mjs:runCommand; src/pi/remote-agent.cjs:commandKeys.
	"unknown_command", // src/node/commands.ts:execute; packages/pi-hc-control/src/control.mjs:runCommand; src/pi/remote-agent.cjs:commandKeys.
	"commands_unsupported", // src/pi/host.ts:#slash refuses before it sends to the control.
	"no_control", // src/pi/host.ts:#slash (list); src/pi/remote-agent.cjs:viaCommandControl, before any send.
	"editor_not_empty", // src/pi/remote-agent.cjs:viaKeys reads the pane before it types.
	"needs_control", // src/pi/remote-agent.cjs:viaKeys and spawn refuse slash text as a message before any keys.
	"command_choice", // components/Composer.tsx:hostCommand offers a choice without sending.
	"busy", // src/node/commands.ts:execute; packages/pi-hc-control/src/control.mjs:builtin.compact, before abort/compact.
	"busy_compacting", // packages/pi-hc-control/src/control.mjs:submit/runCommand refuse before delivery.
	"audit_empty", // src/node/commands.ts:execute refuses an empty audit before mkdir/write; no command effect occurred.
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
 * certain. The exactly-once promise is `once`: it holds only while the message keeps its key (composer-drafts.ts).
 */
export function sendOutcome(error: Failure, hostLabel: string, pi = false): Outcome {
	if (FINAL_REFUSAL.has(error.code ?? "")) return { uncertain: false, text: refusalText(error.message) };
	const text = `${hostLabel} did not answer. Your message is back in the composer.`;
	// PiHost's message route does not forward the requestId. It cannot promise an exactly-once retry.
	if (pi) return { uncertain: true, text: `${text} Check the Pi pane before sending again; it may already have arrived.` };
	return { uncertain: true, text, once: "Send again delivers it once; editing it makes a new message." };
}
