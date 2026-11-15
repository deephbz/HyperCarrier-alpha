// Host kinds: a registered kind (web/src/extensions.ts) resolves routes, labels and roles with no edit to shared code.
import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadSummary } from "../src/shared/protocol.ts";
import { hostKinds } from "../web/src/extensions.ts";
import { hostKind, isPiHost, kindOfThread, PI_KIND, servesHostOps, type HostKind } from "../web/src/host-kinds.ts";
import { findHost, hostLabel, hostLabelFor } from "../web/src/components/host-label.ts";
import { arrangeByLayout } from "../web/src/components/sidebar-layout.ts";
import { href, threadRef } from "../web/src/route.ts";

// A synthetic second source: its Hosts have kind "node" and its thread IDs start with "n:".
const NODE: HostKind = { source: "node", sourceLabel: "node", matches: (host) => (host.kind as string) === "node", ownsThread: (id) => id.startsWith("n:"), herdr: false, reader: true };
const pi = { id: "devbox", label: "devbox", kind: "pi-local" as const, link: "devbox#pi" };
const node = { id: "devbox", label: "devbox", kind: "node" as never, link: "devbox#node" };

// Each case sets the registry it reads and restores the line's own kinds after, so it passes on every line.
function withKinds(t: { after: (fn: () => void) => void }, ...kinds: HostKind[]) {
	const line = hostKinds.splice(0, hostKinds.length, ...kinds);
	t.after(() => void hostKinds.splice(0, hostKinds.length, ...line));
}

test("host kinds: main alone resolves only Pi threads and labels a Host by its own label", (t) => {
	withKinds(t);
	assert.equal(findHost([pi], "devbox", "pi:a")?.link, "devbox#pi");
	assert.equal(findHost([pi], "devbox", "n:a"), undefined, "a thread no kind owns has no source");
	assert.equal(kindOfThread("n:a"), undefined);
	assert.equal(hostLabel(pi, [pi]), "devbox");
	assert.equal(hostLabelFor("devbox#durable", [pi]), "devbox", "an unlisted key shows its Host ID");
	assert.equal(href.thread("devbox#pi", "pi:a"), "#/h/devbox/t/pi%3Aa");
	assert.equal(href.thread("devbox#node", "n:a"), "#/h/devbox%23node/t/n%3Aa", "an unregistered suffix stays");
	assert.equal(hostKind(pi), PI_KIND);
	assert.ok(isPiHost(pi) && servesHostOps(pi));
	assert.ok(!isPiHost(undefined) && !servesHostOps(undefined));
});

test("host kinds: a registered kind owns its threads, routes and role, and shared Host IDs name their source", (t) => {
	withKinds(t, NODE);
	const hosts = [pi, node];
	assert.equal(findHost(hosts, "devbox", "n:a")?.link, "devbox#node");
	assert.equal(findHost(hosts, "devbox", "pi:a")?.link, "devbox#pi");
	assert.equal(findHost(hosts, "devbox"), undefined, "a bare Host ID that names two sources is ambiguous");
	assert.equal(findHost(hosts, "devbox#node")?.link, "devbox#node");
	assert.equal(hostLabel(node, hosts), "devbox · node");
	assert.equal(hostLabel(pi, hosts), "devbox · Pi in Herdr");
	assert.equal(hostLabelFor("devbox#node", hosts), "devbox · node");
	assert.equal(href.thread("devbox#node", "n:a"), "#/h/devbox/t/n%3Aa");
	assert.equal(hostKind(node), NODE);
	assert.ok(!isPiHost(node) && servesHostOps(node));
});

test("host kinds: the sidebar layout keeps a Pi thread with a tab and no pane, and a kind can place it by tab", () => {
	const row = (id: string, location: ThreadSummary["location"]) => ({ id, location, updatedAt: 1 }) as ThreadSummary;
	const threads = [row("pi:a", { workspace: "w", tab: "t" }), row("pi:b", { workspace: "w", tab: "t", pane: "p1" })];
	const layout = { workspaces: [{ id: "w", label: "proj", tabs: [{ id: "t", label: "proj", panes: ["p1", "pi:a"] }] }] } as never;
	const herdr = arrangeByLayout({ threads, layout });
	assert.deepEqual(herdr.groups.map((g) => [g.label, g.rows.map((r) => r.id)]), [["proj", ["pi:b"]]], "a group whose workspace and tab share a label shows it once");
	assert.deepEqual(herdr.unplaced.map((r) => r.id), ["pi:a"]);
	const byTab = arrangeByLayout({ threads, layout }, (t) => t.location?.pane ?? (t.location?.tab ? t.id : undefined));
	assert.deepEqual(byTab.groups.map((g) => g.rows.map((r) => r.id)), [["pi:b", "pi:a"]]);
	assert.deepEqual(byTab.unplaced, []);
});

test("host kinds: a Session citation names its source by the kind's prefix, and its route drops the prefix", (t) => {
	withKinds(t, { ...NODE, citation: "pi-node:" });
	assert.equal(threadRef("devbox#pi", "pi:a"), "devbox/pi:a", "Pi thread IDs name their source; Pi has no prefix");
	assert.equal(threadRef("devbox", "pi:a"), "devbox/pi:a");
	assert.equal(href.ref("devbox/pi:a#e1"), "#/h/devbox/t/pi%3Aa?e=e1");
	assert.equal(threadRef("devbox#node", "n:a"), "devbox/pi-node:n:a", "the link key's suffix names the source");
	assert.equal(threadRef("devbox", "n:a"), "devbox/pi-node:n:a", "a bare Host ID picks the source by the thread ID");
	assert.equal(href.ref("devbox/pi-node:n:a#e1"), "#/h/devbox/t/n%3Aa?e=e1");
	assert.equal(href.ref("devbox/pi:a"), "#/h/devbox/t/pi%3Aa");
});
