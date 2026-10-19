import assert from "node:assert/strict";
import { test } from "node:test";
import { noticeView } from "../web/src/components/notice.ts";

const delivery = (messages: { from: string; content: string }[]) =>
	`These accepted coordination records were delivered to this exact Session.\n${JSON.stringify({ messages: messages.map((m, i) => ({ id: `msg_${i}`, ...m })) }, null, 2)}`;

test("notice row: each extension message names its kind, sender and first line", () => {
	const intercom = noticeView("intercom_message", "**From planner** (/work/p)\n\n_Delivered by intercom at 12:00_\n\nPlease review.\nMore.");
	assert.deepEqual([intercom.kind, intercom.sender, intercom.first, intercom.parts[0]!.text], ["intercom", "planner", "Please review.", "Please review.\nMore."]);
	const direct = noticeView("pi-team-bright.direct-message", delivery([{ from: "lead", content: "Plan accepted.\nDetail." }, { from: "observer", content: "Noted." }]));
	assert.deepEqual([direct.kind, direct.alert, direct.sender, direct.first, direct.parts.length], ["direct message", false, "lead, observer", "Plan accepted.", 2]);
	const alert = noticeView("pi-team-bright.direct-message", delivery([{ from: "lead", content: "[PiTeams clarification Alert alert_1]\nTask: t" }]));
	assert.deepEqual([alert.kind, alert.alert, alert.first], ["alert", true, "[PiTeams clarification Alert alert_1]"]);
	const pickup = noticeView("auto-compact.pickup", "Auto Compact pickup: continue.\n\nBody");
	assert.deepEqual([pickup.kind, pickup.sender, pickup.first], ["pickup", "Auto Compact", "Auto Compact pickup: continue."]);
	const other = noticeView("team.notice", "\n  First line\nrest");
	assert.deepEqual([other.kind, other.sender, other.first], ["team.notice", undefined, "First line"]);
});

test("notice row: a shortened delivery still shows its sender and first line", () => {
	const text = delivery([{ from: "lead \"a\"", content: `Long \u00e9 start.\n${"x".repeat(2000)}` }]).slice(0, 400);
	const view = noticeView("pi-team-bright.direct-message", text);
	assert.deepEqual([view.sender, view.first], ['lead "a"', "Long \u00e9 start."]);
});
