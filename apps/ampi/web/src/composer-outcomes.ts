type Failure = { code?: string; message: string };

/** Only a proven refusal releases a send's key. Transport errors and new codes keep it. */
const FINAL_REFUSAL = new Set([
	"key_conflict", // src/node/submit-keys.ts:claimSubmitKey; src/node/commands.ts:runCommand.
	"command_expired", // src/node/commands.ts:runCommand refuses a retired key before any effect.
	"bad_request", // src/node/server.ts validation; src/node/commands.ts:runCommand; packages/pi-hc-control/src/control.mjs:command.
	"bad_args", // src/node/commands.ts:execute; packages/pi-hc-control/src/control.mjs built-ins.
	"unsupported", // src/node/server.ts op dispatch; components/Composer.tsx:hostCommand, before dispatch.
	"unsupported_command", // src/node/commands.ts:execute; packages/pi-hc-control/src/control.mjs:runCommand.
	"unknown_command", // src/node/commands.ts:execute; packages/pi-hc-control/src/control.mjs:runCommand.
	"commands_unsupported", // src/pi/host.ts:#slash refuses before it sends to the control.
	"command_choice", // components/Composer.tsx:hostCommand offers a choice without sending.
	"busy", // src/node/commands.ts:execute; packages/pi-hc-control/src/control.mjs:builtin.compact, before abort/compact.
	"busy_compacting", // packages/pi-hc-control/src/control.mjs:submit/runCommand refuse before delivery.
	"audit_empty", // src/node/commands.ts:execute refuses an empty audit before mkdir/write; no command effect occurred.
]);

/** Non-send failures can also carry the hub's raw link key. */
export function hostErrorMessage(error: Failure, hostLabel: string): string {
	return error.code === "host_disconnected" ? `${hostLabel} did not answer.` : error.message;
}

/** One result controls the retry key and its explanation for messages and typed commands. */
export function sendOutcome(error: Failure, hostLabel: string, pi = false): { finalRefusal: boolean; text: string } {
	const finalRefusal = FINAL_REFUSAL.has(error.code ?? "");
	if (finalRefusal)
		return { finalRefusal, text: `Not sent: ${error.message.trimEnd().replace(/\.+$/, "")}. Your draft is kept; fix it and send again.` };
	// PiHost's message route does not forward the requestId. It cannot promise an exactly-once retry.
	const next = pi ? "Check the Pi pane before sending again; it may already have arrived."
		: "Send again delivers it once; editing it makes a new message.";
	return { finalRefusal, text: `${hostLabel} did not answer. Your message is back in the composer. ${next}` };
}
