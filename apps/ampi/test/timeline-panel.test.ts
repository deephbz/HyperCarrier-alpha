import assert from "node:assert/strict";
import { test } from "node:test";
import { inPanel, type PanelSelection } from "../web/src/views/cos/panel.ts";

const fleet = [
	{ host: "devbox", threadId: "solo" },
	{ host: "devbox", threadId: "lead", team: "reader" },
	{ host: "devbox", threadId: "worker", team: "reader" },
	{ host: "devbox", threadId: "ops", team: "deploy" },
	{ host: "other", threadId: "lead-copy", team: "reader" },
	{ host: "other", threadId: "solo" },
];
const lanes = (selected: PanelSelection) => fleet.filter((s) => inPanel(s, selected)).map((s) => `${s.host}/${s.threadId}`);

test("Timeline panel on a solo Session shows only that Session", () => {
	assert.deepEqual(lanes({ host: "devbox", threadId: "solo" }), ["devbox/solo"]);
});

test("Timeline panel on a Team lead shows the lead and its members on the same Host", () => {
	assert.deepEqual(lanes({ host: "devbox", threadId: "lead", teamId: "reader" }), ["devbox/lead", "devbox/worker"]);
	assert.deepEqual(lanes({ host: "devbox", threadId: "worker", teamId: "reader" }), ["devbox/lead", "devbox/worker"]);
});
