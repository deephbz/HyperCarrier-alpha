import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostErrorMessage, sendOutcome } from "../web/src/composer-outcomes.ts";
import { hostLabelFor } from "../web/src/components/host-label.ts";

test("Composer final refusals drop retry identity and explain the kept draft without doubled punctuation", () => {
	for (const code of ["key_conflict", "bad_request", "bad_args", "unsupported", "unsupported_command", "unknown_command", "commands_unsupported", "command_choice", "busy", "busy_compacting", "audit_empty"]) {
		for (const message of ["Fix this", "Fix this.", "Fix this.  "])
			assert.deepEqual(sendOutcome({ code, message }, "Workbench"), {
				uncertain: false, text: "Not sent: Fix this. Your draft is kept; fix it and send again.",
			});
	}
});

test("Composer unknown outcomes keep retry identity, name the Host label, and hide raw transport details", () => {
	const host = { id: "devbox", link: "devbox#durable", label: "Workbench", kind: "local" as const };
	const label = hostLabelFor(host.link, [host]);
	for (const code of [undefined, "host_disconnected", "timeout", "not_found", "future_transport_error"]) {
		const outcome = sendOutcome({ code, message: "devbox#durable disconnected" }, label);
		assert.deepEqual(outcome, {
			uncertain: true,
			text: "Workbench did not answer. Your message is back in the composer.",
			once: "Send again delivers it once; editing it makes a new message.",
		});
		assert.doesNotMatch(outcome.text, /#|disconnected|correct the issue/);
	}
});

test("Pi unknown outcomes keep retry identity but warn the owner to check the pane", () => {
	assert.deepEqual(sendOutcome({ code: "host_disconnected", message: "devbox#pi disconnected" }, "Workbench · Pi in Herdr", true), {
		uncertain: true,
		text: "Workbench · Pi in Herdr did not answer. Your message is back in the composer. Check the Pi pane before sending again; it may already have arrived.",
	});
	assert.equal(hostErrorMessage({ code: "host_disconnected", message: "devbox#pi disconnected" }, "Workbench"), "Workbench did not answer.");
	assert.equal(hostErrorMessage({ message: "Cannot read image" }, "Workbench"), "Cannot read image");
});
