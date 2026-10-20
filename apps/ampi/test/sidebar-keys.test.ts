import "./bound.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { sidebarKeyAction } from "../web/src/components/sidebar-keys.ts";

test("sidebar key intents preserve the leader/worker tree", () => {
	assert.equal(sidebarKeyAction("j", false, false, false), "next");
	assert.equal(sidebarKeyAction("k", false, false, false), "previous");
	assert.equal(sidebarKeyAction("g", false, false, false), "first");
	assert.equal(sidebarKeyAction("G", false, false, false), "last");
	assert.equal(sidebarKeyAction("Enter", false, false, false), "open");
	assert.equal(sidebarKeyAction("h", true, true, false), "collapse");
	assert.equal(sidebarKeyAction("h", false, false, true), "parent");
	assert.equal(sidebarKeyAction("h", false, false, false), undefined);
	assert.equal(sidebarKeyAction("l", false, true, false), "expand");
	assert.equal(sidebarKeyAction("l", true, true, false), "child");
	assert.equal(sidebarKeyAction("l", false, false, true), undefined);
});
