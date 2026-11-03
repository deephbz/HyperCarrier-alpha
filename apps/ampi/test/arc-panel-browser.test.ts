import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type WebSocketRoute } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { ArcReplica } from "../src/hub/arc-replica.ts";
import { serviceStatus } from "../src/arc/service/status.ts";
import { arcPanelFixture } from "./arc-panel-fixture.ts";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";

const web = fileURLToPath(new URL("../web", import.meta.url));
const origin = "http://localhost";
let browser: Browser, script: string, css: string;
before(async () => {
	const entry = join(web, "arc-panel-test.js");
	const result = await build({ configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
		name: "arc-panel-test", resolveId: (id) => id === entry ? `\0${entry}` : undefined,
		load: (id) => id === `\0${entry}` ? `import React from 'react'; import { createRoot } from 'react-dom/client'; import { PiPanel } from ${JSON.stringify(join(web, "src/views/PiPanel.tsx"))};
		createRoot(document.getElementById('root')).render(React.createElement(PiPanel, {name:'arc', host:'devbox', threadId:'pi:arc-demo', summary:{id:'pi:arc-demo', activity:'idle', live:true, updatedAt:1792529400000}, setPanel:()=>{}}));` : undefined,
	}], build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "ArcPanelTest" } } });
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string; source?: string; fileName: string }[] };
	script = output.output.find((item) => item.type === "chunk")!.code!;
	css = readFileSync(join(web, "src/styles.css"), "utf8") + output.output.filter((item) => item.fileName.endsWith(".css")).map((item) => item.source).join("\n");
	browser = await chromium.launch({ headless: true, executablePath: findChrome() });
});
after(async () => { await browser?.close(); });
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

test("Arc replica suppresses equal heartbeats but sends real service changes to the panel", async t => {
 const dir = mkdtempSync(join(tmpdir(), "arc-panel-heartbeat-"));
 const page = await browser.newPage();
 let socket: WebSocketRoute | undefined, sid = 0, updates = 0;
 const fixture = arcPanelFixture(), stamp = { id: "synthetic", order: 1, line: null };
 const replica = new ArcReplica({ dir, host: "devbox", requester: "hub", send: () => true, changed() {
  if (socket) { updates++; socket.send(JSON.stringify({ t: "snap", sid, value: { ...fixture, ...replica.value("pi:arc-demo") } })); }
 } });
 t.after(async () => { socket = undefined; replica.disconnect(); await page.context().close(); rmSync(dir, { recursive: true, force: true }); });
 const service = serviceStatus("devbox", { state: "running", running: true, stamp });
 replica.receive({ t: "arc.hello", generation: "one", stamp, expected: stamp, service });
 replica.receive({ t: "arc.status", generation: "one", seq: 1, service, statuses: [], scheduled: [] });
 await page.route("**/*", route => route.fulfill(new URL(route.request().url()).pathname === "/component.js"
  ? { contentType: "text/javascript", body: script }
  : { contentType: "text/html", body: `<meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/component.js"></script>` }));
 await page.routeWebSocket("**/ws", client => client.onMessage(data => {
  const frame = JSON.parse(String(data));
  if (frame.t === "sub") { socket = client; sid = frame.sid; client.send(JSON.stringify({ t: "snap", sid, value: { ...fixture, ...replica.value("pi:arc-demo") } })); }
 }));
 await page.goto(origin);
 await page.getByRole("button", { name: "Build", exact: true }).waitFor();
 replica.receive({ t: "arc.status", generation: "one", seq: 2, service: structuredClone(service), statuses: [], scheduled: [] });
 await frames(page); assert.equal(updates, 0, "an equal heartbeat does not send a panel update");
 replica.receive({ t: "arc.status", generation: "one", seq: 3, service: { ...service, state: "fault" }, statuses: [], scheduled: [] });
 await page.getByText(/devbox: Arc service stopped Builds after an internal error/).waitFor();
 assert.equal(updates, 1);
 assert.equal(await page.getByRole("button", { name: "Build", exact: true }).isDisabled(), true);
});

test("Arc panel renders chapters without timestamps and keeps disclosure usable", async (t) => {
 for (const at of [null, "not-a-time"]) await t.test(at === null ? "null time" : "unparseable time", async (t) => {
 const page = await browser.newPage({ viewport: { width: 380, height: 1000 }, timezoneId: "UTC" });
 t.after(() => page.context().close());
 const value = arcPanelFixture(2), errors: string[] = [];
 value.sourceCount = value.receipt!.asOfCount;
 Object.assign(value.receipt!.chapters[1]!, { firstAt: at, lastAt: at });
 page.on("pageerror", error => errors.push(error.message));
 await page.route("**/*", route => route.fulfill(new URL(route.request().url()).pathname === "/component.js"
  ? { contentType: "text/javascript", body: script }
  : { contentType: "text/html", body: `<meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/component.js"></script>` }));
 await page.routeWebSocket("**/ws", client => client.onMessage(data => {
  const frame = JSON.parse(String(data));
  if (frame.t === "sub") client.send(JSON.stringify({ t: "snap", sid: frame.sid, value }));
 }));
 await page.goto(origin);
 await page.locator(".arc-goal").waitFor({ timeout: 5000 });
 assert.deepEqual(errors, []);
 assert.match(await page.locator(".arc-status").innerText(), /covers to time unavailable/);
 assert.match(await page.locator(".arc-timeline").innerText(), /Chapter times unavailable/);
 const band = page.locator('[data-band="2"]');
 assert.ok(Number(await band.getAttribute("width")) > 0);
 assert.ok(Number.isFinite(Number(await band.getAttribute("x"))));
 await band.click();
 await page.locator('[data-chapter="2"] .arc-chapter-summary').waitFor();
 assert.match(await page.locator('[data-chapter="2"] .arc-span').innerText(), /time unavailable/);
 assert.ok(!/NaN|Invalid Date/.test(await page.locator("#root").innerHTML()));
 if (process.env.AMPI_ARC_PROOF) {
  mkdirSync(process.env.AMPI_ARC_PROOF, { recursive: true });
  await page.screenshot({ path: join(process.env.AMPI_ARC_PROOF, `chapter-${at === null ? "null" : "invalid"}-time.png`) });
 }
 });
});

test("Arc render fault stays inside the panel and Retry view does not Build", async (t) => {
 const page = await browser.newPage({ viewport: { width: 720, height: 1000 } });
 t.after(() => page.context().close());
 const value = arcPanelFixture(2);
 // A non-renderable claim forces a descendant render exception without a production fault switch.
 value.receipt!.goal.text = { forced: "render fault" } as unknown as string;
 const peers: { client: WebSocketRoute; sid: string }[] = [], operations: string[] = [];
 await page.route("**/*", route => route.fulfill(new URL(route.request().url()).pathname === "/component.js"
  ? { contentType: "text/javascript", body: script }
  : { contentType: "text/html", body: `<meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/component.js"></script>` }));
 await page.routeWebSocket("**/ws", client => client.onMessage(data => {
  const frame = JSON.parse(String(data));
  if (frame.t === "sub") { peers.push({ client, sid: frame.sid }); client.send(JSON.stringify({ t: "snap", sid: frame.sid, value })); }
  if (frame.t === "req") operations.push(frame.op);
 }));
 await page.goto(origin);
 await page.getByRole("alert").filter({ hasText: "Arc could not be displayed" }).waitFor({ timeout: 5000 });
 const preferred = page.getByRole("button", { name: "Open Arc by default", exact: true });
 await preferred.click();
 assert.equal(await preferred.getAttribute("aria-pressed"), "true", "panel tabs remain interactive after an Arc fault");
 if (process.env.AMPI_ARC_PROOF) {
  mkdirSync(process.env.AMPI_ARC_PROOF, { recursive: true });
  await page.screenshot({ path: join(process.env.AMPI_ARC_PROOF, "arc-render-fault.png") });
 }
 await page.getByText("Error details", { exact: true }).click();
 assert.match(await page.getByRole("alert").innerText(), /React|Objects are not valid/);
 value.receipt!.goal.text = "Recovered Arc goal";
 for (const { client, sid } of peers) client.send(JSON.stringify({ t: "snap", sid, value }));
 await frames(page);
 await page.getByRole("button", { name: "Retry view", exact: true }).click();
 await page.getByText("Recovered Arc goal", { exact: false }).waitFor({ timeout: 5000 });
 assert.equal(await page.getByRole("alert").count(), 0);
 assert.ok(!operations.includes("view.arc.build"), "retry only re-renders the saved Arc");
});

test("Arc Goal uses the Now body style on desktop and touch", async (t) => {
	for (const hasTouch of [false, true]) {
		await t.test(hasTouch ? "touch" : "desktop", async (t) => {
			const page = await browser.newPage({ hasTouch, viewport: { width: hasTouch ? 380 : 720, height: 1000 } });
			t.after(() => page.context().close());
			const value = arcPanelFixture();
			value.receipt!.kept = ["goal"];
			await page.route("**/*", (route) => route.fulfill(new URL(route.request().url()).pathname === "/component.js"
				? { contentType: "text/javascript", body: script }
				: { contentType: "text/html", body: `<meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/component.js"></script>` }));
			await page.routeWebSocket("**/ws", (client) => client.onMessage((data) => {
				const frame = JSON.parse(String(data));
				if (frame.t === "sub") client.send(JSON.stringify({ t: "snap", sid: frame.sid, value }));
			}));
			await page.goto(origin);
			await page.locator(".arc-goal").waitFor();
			const styles = await page.evaluate(() => {
				const style = (selector: string) => {
					const s = getComputedStyle(document.querySelector(selector)!);
					return { size: s.fontSize, line: s.lineHeight, color: s.color };
				};
				return { goal: style(".arc-goal"), now: style(".arc-now > p:not([class])"),
					bold: getComputedStyle(document.querySelector(".arc-goal > b")!).fontWeight,
					cite: style(".arc-goal .arc-cite"), kept: style(".arc-goal .arc-kept") };
			});
			assert.deepEqual(styles.goal, styles.now, "Goal has the Now paragraph size, line height and color");
			assert.equal(styles.goal.size, hasTouch ? "16px" : "13px");
			assert.equal(styles.goal.line, hasTouch ? "24px" : "20px");
			assert.equal(styles.bold, "500");
			assert.equal(styles.cite.size, "11px");
			assert.equal(styles.kept.size, "12px");
		});
	}
});

test("Arc service facts, request outcomes, loss disclosure and stale elapsed on desktop and touch", async (t) => {
	for (const hasTouch of [false, true]) await t.test(hasTouch ? "touch" : "desktop", async (t) => {
		const page = await browser.newPage({ hasTouch, viewport: { width: hasTouch ? 380 : 720, height: 1000 }, timezoneId: "UTC" });
		t.after(() => page.context().close());
		await page.clock.install({ time: new Date("2026-11-03T04:00:00Z") });
		const value = arcPanelFixture();
		const rendered: Record<string, string> = {};
		let socket: WebSocketRoute, sid: number, buildRequestId: number;
		let refuseDismiss = false;
		const requests: { op: string; args: Record<string, unknown> }[] = [], errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.route("**/*", (route) => {
			const url = new URL(route.request().url());
			assert.equal(url.origin, origin);
			return route.fulfill(url.pathname === "/component.js" ? { contentType: "text/javascript", body: script } : { contentType: "text/html", body: `<meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/component.js"></script>` });
		});
		await page.routeWebSocket("**/ws", (client) => {
			socket = client;
			client.onMessage((data) => {
				const frame = JSON.parse(String(data));
				if (frame.t === "sub") { sid = frame.sid; client.send(JSON.stringify({ t: "snap", sid, value })); }
				if (frame.t === "req") {
					requests.push({ op: frame.op, args: frame.args });
					if (frame.op === "view.arc.build") { buildRequestId = frame.id; return; }
					client.send(JSON.stringify({ t: "res", id: frame.id, ok: true, value: frame.op === "view.arc.dismiss" ? refuseDismiss ? { outcome: "refused", code: "source" } : { outcome: "dismissed", revision: 2 } : { outcome: "unknown", requestId: "synthetic-request" } }));
				}
			});
		});
		const send = async () => { socket!.send(JSON.stringify({ t: "snap", sid: sid!, value })); await frames(page); };
		await page.goto(origin);
		await page.locator(".arc-goal").waitFor();
		assert.equal(requests.length, 0);
		await page.getByRole("button", { name: "Build", exact: true }).click();
		await page.getByRole("button", { name: "Build requested", exact: true }).waitFor();
		const firstCommand = String(requests.at(-1)!.args.requestId);
		value.request = { requestId: firstCommand, outcome: "accepted", buildId: "synthetic-build" }; await send();
		socket!.send(JSON.stringify({ t: "res", id: buildRequestId!, ok: true, value: { outcome: "unknown", requestId: firstCommand } })); await frames(page);
		assert.equal(await page.getByText(/Build request status unknown/).count(), 0, "accepted knowledge wins over a delayed unknown for the same command");
		await page.getByRole("button", { name: "Build", exact: true }).click();
		await page.getByRole("button", { name: "Build requested", exact: true }).waitFor();
		const secondCommand = String(requests.at(-1)!.args.requestId);
		assert.notEqual(firstCommand, secondCommand);
		socket!.send(JSON.stringify({ t: "res", id: buildRequestId!, ok: true, value: { outcome: "unknown", requestId: secondCommand } }));
		await page.getByText("Build request status unknown. AmPi sends it again when devbox reconnects.", { exact: true }).waitFor();
		value.request = { requestId: secondCommand, outcome: "accepted", buildId: "synthetic-build" };
		value.status = { state: "waiting", elapsedMs: 0, waitCause: "capacity", wait: { reason: "capacity", running: 8, limit: 8, scope: "global", byHost: [{ host: "devbox", running: 5 }, { host: "lab", running: 3 }] } };
		await send();
		assert.match(await page.locator(".arc-panel").innerText(), /Waiting for a model slot: 8 of 8 in use \(devbox 5, lab 3\)\./);
		assert.equal(await page.locator(".arc-elapsed").count(), 0);
		assert.equal(await page.getByRole("button", { name: "Waiting", exact: true }).isDisabled(), true);
		assert.equal(await page.getByRole("alert").count(), 0);
		for (const [waitCause, expected] of [["admission-unavailable", "Waiting: AmPi cannot check the shared model limit now."], ["source-unavailable", "Waiting: the Session file on devbox cannot be read now."], ["survivor", "Waiting for an earlier model process on devbox to end."]] as const) {
			value.status = { state: "waiting", elapsedMs: 0, waitCause }; await send();
			assert.ok((await page.locator(".arc-panel").innerText()).includes(expected));
		}
		value.status = { state: "uncertain", elapsedMs: 133000, pause: "uncertain-call", detail: "Synthetic process identity could not be verified." }; await send();
		assert.match(await page.locator(".arc-panel").innerText(), /Automatic Builds paused: the last Build stopped during a model call that may have been charged\. Press Build to continue \(it may charge again\)\./);
		assert.equal(await page.getByRole("button", { name: "Build", exact: true }).isEnabled(), true);
		assert.equal(await page.getByText("Synthetic process identity could not be verified.").isVisible(), false);
		await page.getByText("Build details", { exact: true }).click();
		assert.equal(await page.getByText("Synthetic process identity could not be verified.").isVisible(), true);
		assert.equal(await page.locator(".arc-elapsed").count(), 0);
		await page.getByText("Build details", { exact: true }).click();
		value.status = { state: "queued", elapsedMs: 0, nextAt: "2026-11-03T04:05:00Z" }; await send();
		assert.equal(await page.locator(".arc-elapsed").count(), 0);
		for (const [code, sentence] of [["sign-in", "Build failed: no sign-in for the Arc model on devbox."], ["model-mismatch", "Build result is uncertain: the model that answered differs from the setting."], ["quota", "Build failed: model quota reached."], ["model", "Build failed: the model call failed."], ["answer", "Build failed: the model's answer could not be used."], ["settings", "Build failed: Arc settings on devbox are invalid."], ["internal", "Build failed."]] as const) {
			value.status = { sessionRef: "synthetic-session", buildId: "synthetic-build", state: "failed", elapsedMs: 41000, observedAt: "2026-11-03T04:00:00Z", nextAt: "2026-11-03T05:00:00Z", record: { ...value.receipt!.builds.at(-1)!, error: { code, message: "Synthetic failure diagnostic." } } }; await send();
			assert.ok((await page.getByRole("alert").innerText()).startsWith(`${sentence} Next try 05:00. Showing the last good Arc.`));
			assert.equal(await page.locator(".arc-elapsed").count(), 0);
			assert.equal(await page.getByText("Synthetic failure diagnostic.", { exact: true }).isVisible(), false);
			assert.equal(await page.getByText("Build details", { exact: true }).evaluate((detail) => Boolean(document.querySelector(".arc-error")!.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING)), true, "the failure sentence precedes its detail disclosure");
		}
		value.status = { state: "idle", elapsedMs: 0 };
		value.request = { requestId: secondCommand, outcome: "refused", code: "settings", detail: "Synthetic model setting is invalid." }; await send();
		await page.getByText("Build request refused. Arc settings on devbox are invalid.", { exact: true }).waitFor();
		assert.equal(await page.getByText("Synthetic model setting is invalid.").isVisible(), false);
		value.request = { requestId: secondCommand, outcome: "not-sent" }; await send();
		await page.getByText("devbox is not reachable. The Arc cannot build now.", { exact: true }).waitFor();
  for (const text of ["This AmPi is older than devbox. Update it.", "devbox: AmPi could not replace the older Arc service (timed out). Run ampi arc status --host devbox; the log is /synthetic/service.log."]) {
   value.services = [{ host: "devbox", state: "error", text }]; await send();
   await page.getByText(text, { exact: true }).waitFor();
   assert.equal(await page.getByRole("button", { name: "Build", exact: true }).isDisabled(), true);
  }
		for (const service of [{ host: "devbox", state: "no-sign-in", model: "test/model", path: "/synthetic/auth.json" }, { host: "devbox", state: "invalid-settings", path: "/synthetic/settings.json", key: "ampi_arc.model" }, { host: "devbox", state: "updating" }, { host: "devbox", state: "stopped" }, { host: "devbox", state: "fault" }, { host: "devbox", state: "stopping" }, { host: "devbox", state: "busy" }, { host: "devbox", state: "error" }, { host: "devbox", state: "cannot-start", prerequisite: "perl" }, { host: "devbox", state: "unreachable", since: "2026-11-03T04:00:00Z" }] as const) {
			value.services = [service]; await send();
			assert.match(await page.locator(".arc-service").innerText(), /devbox: (Arc (service|Builds|store|maintenance)|Stopping Arc|Host is unreachable)/);
   if (!["no-sign-in", "invalid-settings"].includes(service.state)) {
    assert.equal(await page.getByRole("button", { name: "Build", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Rebuild", exact: true, includeHidden: true }).isDisabled(), true);
   }
			if (service.state === "stopped") assert.equal(await page.locator(".arc-service").innerText(), "devbox: Arc service is stopped. A linked hub restarts it within seconds.");
			if (service.state === "stopping") {
				value.services = [{ ...service, text: "devbox: Stopping Arc drains Builds for every client. A linked hub restarts it within seconds." }]; await send();
				rendered.stopping = await page.locator(".arc-service").innerText();
				assert.equal(rendered.stopping, "devbox: Arc service is stopping. It drains Builds for every client; a linked hub restarts it within seconds.");
			}
		}
  value.services = [{ host: "devbox", state: "stopped" }];
  value.request = { requestId: secondCommand, outcome: "refused", code: "service", detail: "Synthetic stopped service." }; await send();
  const refusal = page.getByText("Build request refused. devbox: Arc service is stopped. A linked hub restarts it within seconds.", { exact: true });
  await refusal.waitFor(); rendered.refusal = await refusal.innerText();
  assert.doesNotMatch(await page.locator(".arc-panel").innerText(), /see the line above/);
  const savedReceipt = value.receipt; value.receipt = undefined; value.v2Removed = true; await send();
  await page.getByText("Arcs from the previous version were removed. Build to create this Session's Arc.", { exact: true }).waitFor();
  value.receipt = savedReceipt; await send();
  assert.equal(await page.getByText(/Arcs from the previous version were removed/).count(), 0);
		value.services = [{ host: "devbox", state: "running", version: "2.1.0" }]; await send();
  assert.equal(await page.getByRole("button", { name: "Build", exact: true }).isEnabled(), true);
		assert.equal(await page.locator(".arc-service").count(), 0, "healthy service facts do not add a status line");
  assert.equal(await page.getByText(/Build request refused/).count(), 0, "recovery hides the service refusal");
  assert.equal(await page.getByText("Request details", { exact: true }).count(), 0, "recovery also hides the refusal diagnostic");
  value.request = { requestId: secondCommand, outcome: "unknown", waitFor: "service" }; await send();
  const serviceWait = page.getByText("Build request status unknown. AmPi sends it again when the Arc service on devbox is ready.", { exact: true });
  await serviceWait.waitFor(); rendered.drain = await serviceWait.innerText();
  value.services = [{ host: "devbox", state: "unreachable", since: "2026-11-03T03:52:00Z", text: "devbox: Host is unreachable. Check the SSH connection, then run ampi arc status --host devbox." }]; await send();
  await page.getByText("Build request status unknown. AmPi sends it again when devbox reconnects.", { exact: true }).waitFor();
  for (const browserTime of ["2026-11-03T03:55:00Z", "2026-11-03T04:05:00Z"]) {
   await page.clock.setFixedTime(new Date(browserTime));
   rendered.unreachable = await page.locator(".arc-service").innerText();
   assert.equal(rendered.unreachable, "devbox: Host is unreachable since 03:52. Check the SSH connection, then run ampi arc status --host devbox.");
  }
  if (process.env.AMPI_ARC_PROOF) {
   mkdirSync(process.env.AMPI_ARC_PROOF, { recursive: true });
   writeFileSync(join(process.env.AMPI_ARC_PROOF, `service-text-${hasTouch ? "touch" : "desktop"}.json`), JSON.stringify(rendered, null, 2) + "\n");
  }
  value.services = [{ host: "devbox", state: "running" }]; value.request = { requestId: secondCommand, outcome: "accepted", buildId: "synthetic-build" }; await send();
		value.receipt!.points = value.receipt!.points.filter((p) => !p.needsYou);
		value.receipt!.drops = [{ id: "loss-1", title: "Confirm the target", kind: "decision", reason: "No valid citation.", needsYou: true, from: "reply-3", to: "reply-5", fromPosition: 3, toPosition: 5 }]; await send();
		assert.match(await page.locator(".arc-needs .arc-drop").innerText(), /a decision from messages 3–5/);
		assert.match((await page.locator(".arc-drop a").getAttribute("href"))!, /e=reply-3/);
		assert.equal(await page.getByText("No valid citation.").isVisible(), false);
		assert.equal(await page.getByRole("button", { name: "Dismiss warning: Confirm the target" }).count(), 0, "a hub that cannot dismiss offers no Dismiss button");
		assert.match(await page.locator(".arc-needs h3").innerText(), /0 · 1 not added/);
		value.canDismiss = true; await send();
		const dismissButton = page.getByRole("button", { name: "Dismiss warning: Confirm the target" });
		assert.ok((await dismissButton.boundingBox())!.height >= (hasTouch ? 40 : 24));
		await dismissButton.click();
		await page.getByText("Dismissing…", { exact: true }).waitFor();
		assert.equal(await dismissButton.isDisabled(), true);
		assert.deepEqual(requests.at(-1), { op: "view.arc.dismiss", args: { threadId: "pi:arc-demo", dropId: "loss-1", toPosition: 5 } });
		assert.equal(await page.locator(".arc-drop").count(), 1, "the receipt owns clearing; an ack alone does not hide a warning");
		const dropped = value.receipt!.drops![0]!;
		value.receipt!.drops = []; await send();
		assert.equal(await page.locator(".arc-drop").count(), 0);
		refuseDismiss = true;
		value.receipt!.drops = [{ ...dropped, toPosition: 6 }]; await send();
		await dismissButton.click();
		await page.getByText("The warning could not be dismissed. Try again.", { exact: true }).waitFor();
		assert.equal(await page.locator(".arc-drop").filter({ has: dismissButton }).getByRole("alert").innerText(), "The warning could not be dismissed. Try again.");
		assert.equal(await page.locator(".arc-panel > [role=alert]").count(), 0, "dismissal feedback stays with its warning");
		assert.equal(await dismissButton.isEnabled(), true);
		assert.equal(await page.locator(".arc-drop").count(), 1);
		value.receipt!.drops = []; await send();
		value.request = { requestId: secondCommand, outcome: "accepted", buildId: "synthetic-build" };
		for (const browserTime of ["2026-11-03T03:55:00Z", "2026-11-03T04:05:00Z"]) {
			await page.clock.setFixedTime(new Date(browserTime));
			value.status = { state: "building", elapsedMs: 65_000, observedAt: browserTime === "2026-11-03T03:55:00Z" ? "2026-11-03T03:59:59Z" : "2026-11-03T04:00:00Z" }; await send();
			await page.getByText("Elapsed 1:05", { exact: true }).waitFor();
		}
		await page.getByText("Elapsed 1:05", { exact: true }).waitFor();
		await page.clock.fastForward(2000);
		await page.getByText("Elapsed 1:07", { exact: true }).waitFor();
		value.statusStale = true;
		value.services = [{ host: "devbox", state: "unreachable", since: "2026-11-03T04:00:02Z" }]; await send();
		const frozen = await page.locator(".arc-elapsed").innerText();
		assert.match(frozen, /1:07 · as of 04:00/);
		await page.clock.fastForward(10_000);
		assert.equal(await page.locator(".arc-elapsed").innerText(), frozen);
		assert.doesNotMatch(await page.locator(".arc-status").innerText(), /newer message/);
		assert.equal(await page.locator(".arc-panel").evaluate((el) => el.scrollWidth > el.clientWidth), false);
		value.builderHost = "devbox";
		value.receipt!.builds.at(-1)!.requester = "desk";
		value.receipt!.builds.at(-1)!.possibleRepeatCost = true; await send();
		await page.locator(".arc-builds > summary").click();
		assert.match(await page.locator(".arc-builds").innerText(), /from desk · built on devbox/);
		assert.match(await page.locator(".arc-builds").innerText(), /may have been charged/);
		assert.deepEqual(errors, []);
	});
});

test("Arc panel: source disclosure, timeline sync, scoped boards, receipt arrivals and narrow themes", async (t) => {
	const page = await browser.newPage({ viewport: { width: 720, height: 1000 }, timezoneId: "UTC" });
	t.after(() => page.context().close());
	page.setDefaultTimeout(5000);
	const errors: string[] = [], requests: { op: string; args: Record<string, unknown> }[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let socket: WebSocketRoute, sid: number;
	let value = arcPanelFixture();
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== origin) { errors.push(`External request ${url.origin}`); return route.abort(); }
		if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: script });
		return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><style>${css}\n#root,.panel{width:100%;height:100vh;min-width:0}.panel-body{overflow-anchor:none}</style><div id="root"></div><script src="/component.js"></script>` });
	});
	await page.routeWebSocket("**/ws", (client) => {
		socket = client;
		client.onMessage((data) => {
			const frame = JSON.parse(String(data));
			if (frame.t === "sub") { assert.equal(frame.topic.view, "arc"); sid = frame.sid; client.send(JSON.stringify({ t: "snap", sid, value })); }
			if (frame.t === "req") {
				requests.push({ op: frame.op, args: frame.args });
				client.send(JSON.stringify({ t: "res", id: frame.id, ok: true, value: frame.op === "thread.entry" ? { text: `The source starts here. Evidence for ${frame.args.entry}. The source ends here.`, next: 0, more: false, version: "fixture" } : {} }));
			}
		});
	});
	await page.goto(origin);
	await page.getByRole("heading", { name: "Chapters (15)", exact: true }).waitFor();
	assert.equal(requests.length, 0, "reading a receipt makes no request or Build");
	assert.deepEqual(await page.locator(".arc-needs [data-point]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-point"))), ["K1", "K2", "K5"]);
	assert.match(await page.locator(".arc-needs").innerText(), /Unblock[\s\S]*Confirm or reverse[\s\S]*Answer/);
	// A kept point shows its age where the owner reads it.
	assert.deepEqual(await page.locator(".arc-needs .arc-kept").evaluateAll((nodes) => nodes.map((n) => n.closest("[data-point]")?.getAttribute("data-point"))), ["K2"]);
	const row = page.locator('[data-chapter="3"] .arc-chapter-row');
	await row.hover();
	assert.equal(await page.locator('[data-band="3"]').getAttribute("class"), "arc-band  hover");
	assert.equal(await page.locator('[data-number="3"]').getAttribute("class"), "hover");
	await row.click();
	assert.equal(await row.getAttribute("aria-expanded"), "true");
	assert.equal(await page.locator(".arc-band-flash").count(), 1);
	await page.locator('[data-band="2"]').click();
	assert.equal(await page.locator('[data-chapter="2"] .arc-chapter-row').getAttribute("aria-expanded"), "true");
	const beforePath = await page.locator(".arc-stream").getAttribute("d");
	await page.getByRole("button", { name: "$", exact: true }).click();
	assert.notEqual(await page.locator(".arc-stream").getAttribute("d"), beforePath);
	await page.getByRole("button", { name: "Expand all", exact: true }).click();
	assert.equal(await page.locator('.arc-chapter-row[aria-expanded="true"]').count(), 15);
	await page.getByRole("button", { name: "Collapse all", exact: true }).click();
	assert.equal(await page.locator('.arc-chapter-row[aria-expanded="true"]').count(), 0);
	await row.click();
	await page.locator('[data-chapter="3"]').getByRole("button", { name: "Show its 4 key points" }).click();
	assert.equal(await page.getByLabel("Key point scope").inputValue(), "3");
	assert.equal(await page.locator(".arc-key-points h2").innerText(), "Key points (4)");
	// The Arc panel uses the shared type scale: headings and the Now label at body size, meta one step below.
	assert.deepEqual(await page.evaluate(() => [".arc-key-points h2", ".arc-now-label", ".arc-meta"].map((s) => getComputedStyle(document.querySelector(s)!).fontSize)), ["13px", "13px", "12px"]);
	assert.equal(await page.getByRole("button", { name: "Requests (1)" }).count(), 1);
	await page.getByRole("button", { name: "Requests (1)" }).click();
	assert.equal(await page.locator(".arc-board [data-point]").count(), 1);
	await page.getByLabel("Key point scope").selectOption("all");
	assert.equal(await page.getByRole("button", { name: "Requests (15)" }).count(), 1);
	const cite = page.locator(".arc-now .arc-cite").first();
	assert.equal(await cite.innerText(), "reply-15", "the chip retains a readable message reference");
	assert.ok((await page.locator(".arc-cite").allTextContents()).every((label) => /[0-9]/.test(label)), "every synthetic citation has its ID suffix");
	await cite.hover();
	await page.getByRole("region", { name: "Source reply-15" }).locator(".arc-source mark").waitFor();
	assert.match(await page.getByRole("region", { name: "Source reply-15" }).innerText(), /The source starts here\.[\s\S]*Evidence for reply-15\./);
	assert.equal(requests.filter((r) => r.op === "thread.entry").length, 1);
	await cite.click();
	assert.match(page.url(), /e=reply-15&p=arc/);
	await page.getByRole("button", { name: "Build", exact: true }).click();
	await page.getByLabel("Arc Build options").click();
	await page.getByRole("button", { name: "Rebuild", exact: true }).click();
	assert.deepEqual(requests.filter((r) => r.op === "view.arc.build").map(({ args: { requestId, ...args } }) => { assert.equal(typeof requestId, "string"); return args; }), [{ threadId: "pi:arc-demo" }, { threadId: "pi:arc-demo", rebuild: true }]);

	// A receipt arrival adds content above the reader. It must preserve the visible chapter and its open state.
	await row.click(); await row.click();
	await row.scrollIntoViewIfNeeded(); await frames(page);
	const top = await row.evaluate((el) => el.getBoundingClientRect().top);
	value = structuredClone(value);
	value.receipt!.builtAt = "2026-10-21T21:01:00Z";
	value.lastStopAt = "2026-10-21T20:59:00Z";
	value.receipt!.now.text += " Additional source checks passed.";
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText(/Updated 21:01/).waitFor(); await frames(page);
	assert.equal(await row.getAttribute("aria-expanded"), "true");
	assert.match(await page.locator(".arc-now").innerText(), /Its last report was 20:59/);
	assert.ok(Math.abs(await row.evaluate((el) => el.getBoundingClientRect().top) - top) < 2, "receipt arrival preserves the reading anchor");

	for (const width of [720, 559, 380, 320]) {
		await page.setViewportSize({ width, height: 1000 }); await frames(page);
		const layout = await page.evaluate(() => {
			const panel = document.querySelector(".panel-body")!;
			const columns = [".arc-span", ".arc-tokens", ".arc-cost"].map((selector) => [...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect().right));
			return { overflow: panel.scrollWidth - panel.clientWidth, columns, widths: [...document.querySelectorAll("[data-band]")].map((el) => el.getBoundingClientRect().width), board: getComputedStyle(document.querySelector(".arc-board")!).gridTemplateColumns.split(" ").length, secondLine: document.querySelector(".arc-span")!.getBoundingClientRect().top > document.querySelector(".arc-label")!.getBoundingClientRect().top };
		});
		assert.ok(layout.overflow <= 1, `${width}px: no sideways scroll (${layout.overflow})`);
		for (const column of layout.columns) assert.ok(Math.max(...column) - Math.min(...column) < 1, `${width}px: right columns align`);
		assert.ok(Math.min(...layout.widths) >= 7.9, `${width}px: every chapter band is clickable`);
		if (width < 560) { assert.equal(layout.board, 1); assert.equal(layout.secondLine, true); }
	}
	await page.setViewportSize({ width: 380, height: 1100 });
	await page.getByRole("button", { name: "Collapse all", exact: true }).click();
	await page.locator('[data-chapter="15"] .arc-chapter-row').click();
	await page.locator(".panel-body").evaluate((el) => { el.scrollTop = 0; });
	const proof = process.env.AMPI_ARC_PROOF;
	for (const theme of ["light", "dark"]) {
		await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme); await frames(page);
		const colors = await page.locator(".arc-now").evaluate((el) => ({ text: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
		assert.notEqual(colors.text, colors.background);
		if (proof) { mkdirSync(proof, { recursive: true }); await page.screenshot({ path: join(proof, `arc-panel-${theme}-380.png`) }); }
	}
	// With automatic Builds on, a failure stays queued with its error until the retry.
	value.status = { state: "queued", error: { code: "model", message: "Synthetic provider unavailable" }, nextAt: "2026-10-21T21:05:00Z" };
	value.receipt!.asOfCount = 640; value.stale = 436; value.sourceCount = 1076;
	value.receipt!.builds.at(-1)!.state = "failed"; value.receipt!.builds.at(-1)!.error = value.status.error;
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByRole("alert").waitFor();
	assert.match(await page.getByRole("alert").innerText(), /Showing the last good Arc/);
	assert.equal(await page.locator("[data-chapter]").count(), 15);
	assert.match(await page.locator(".arc-status").innerText(), /Covers 640 of 1,076 messages/);
	assert.match(await page.getByRole("alert").innerText(), /Build failed: the model call failed\..*Build to cover the remaining messages/);
	assert.equal(await page.getByRole("button", { name: "Build", exact: true }).isEnabled(), true);
	assert.match(await page.getByRole("alert").innerText(), /Next try 21:05/);
	assert.equal((await page.locator(".arc-panel").innerText()).match(/Next try|starts 21:05/g)?.length, 1, "the retry time shows once");
	assert.match(await page.locator(".arc-status").innerText(), /Saved 21:01 \(partial\)/);
	// A partial Arc reads like a complete one: the status line alone says what it covers.
	assert.doesNotMatch(await page.locator(".arc-panel h2").first().innerText(), /as of/i);
	assert.doesNotMatch(await page.locator(".arc-needs").innerText(), /later messages/);
	await page.locator(".panel-body").evaluate((el) => { el.scrollTop = 0; });
	for (const theme of ["light", "dark"]) {
		await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme); await frames(page);
		if (proof) await page.screenshot({ path: join(proof, `arc-partial-${theme}-380.png`) });
	}
	value.status = { state: "queued", nextAt: "2026-10-21T21:05:00Z" };
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText(/Queued/).waitFor();
	assert.match(await page.locator(".arc-status").innerText(), /Saved 21:01 \(partial\).*Covers 640 of 1,076 messages/s);
	for (const theme of ["light", "dark"]) {
		await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme); await frames(page);
		if (proof) await page.screenshot({ path: join(proof, `arc-queued-${theme}-380.png`) });
	}
	// An older hub sends progress text only; the panel shows it as it is.
	value.status = { state: "building", progress: "Building window 1, call 1" };
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText(/Building window/).waitFor();
	assert.match(await page.locator(".arc-status").innerText(), /Covers 640 of 1,076 messages/);
	// Contract: arc.md / View: progress names the whole job in one muted italic line; elapsed time ticks outside the
	// status region, and the retry reason is on hover only.
	const startedAt = new Date(Date.now() - 72_000).toISOString();
	value.status = { state: "building", elapsedMs: 72000, observedAt: new Date().toISOString(), progress: "Building messages 641–1,076 of 1,076 · part 2 of 3 · try 2 of 3", work: { from: 641, to: 1076, total: 1076, part: 2, parts: 3, attempt: 2, attempts: 3, reason: "Expected an object", startedAt } };
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	const progress = page.locator(".arc-progress");
	await progress.waitFor();
	assert.equal(await progress.getByRole("status").innerText(), "Building messages 641–1,076 · part 2 of 3 · try 2 of 3");
	assert.match(await page.locator(".arc-elapsed").innerText(), /^Elapsed 1:1\d$/);
	assert.equal(await progress.getByRole("status").getAttribute("title"), "Last answer rejected: Expected an object");
	assert.equal(await progress.evaluate((el) => getComputedStyle(el).fontStyle), "italic");
	assert.doesNotMatch(await page.locator(".arc-panel").innerText(), /Expected an object/, "the internal reason stays out of the text");
	value.status = { state: "queued", progress: "Waiting for a model slot" };
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText("Waiting for a model slot", { exact: true }).waitFor();
	assert.equal(await page.getByRole("alert").count(), 0, "admission wait is not a red model failure");
	value.branchChanged = true; delete value.sourceCount;
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText(/branch or selection changed/).waitFor();
	assert.doesNotMatch(await page.locator(".arc-status").innerText(), /Covers 640 of/);
	value.branchChanged = false; value.sourceCount = 1076;
	value.status = { state: "idle" }; value.stale = 0;
	value.receipt!.builds.at(-1)!.state = "done"; delete value.receipt!.builds.at(-1)!.error;
	value.receipt!.asOfCount = 1076; value.receipt!.builtAt = "2026-10-21T21:02:00Z";
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText(/Updated 21:02/).waitFor();
	assert.equal(await page.getByRole("alert").count(), 0);
	assert.doesNotMatch(await page.locator(".arc-status").innerText(), /Covers 640/);
	assert.equal(await page.locator("[data-chapter]").count(), 15);
	value = arcPanelFixture(40);
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByRole("heading", { name: "Chapters (40)", exact: true }).waitFor();
	for (const width of [380, 720]) {
		await page.setViewportSize({ width, height: 1100 }); await frames(page);
		await page.locator(".arc-timeline").scrollIntoViewIfNeeded();
		const labels = await page.evaluate(() => {
			const bounds = (selector: string) => [...document.querySelectorAll(selector)].filter(el => getComputedStyle(el).visibility !== "hidden").map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; });
			return { numbers: bounds("[data-number]"), ticks: bounds(".arc-time-ticks > span"), bands: bounds("[data-band]") };
		});
		assert.equal(labels.bands.length, 40); assert.ok(labels.bands.every(b => b.width > 0));
		for (const group of [labels.numbers, labels.ticks]) for (let i = 1; i < group.length; i++) assert.ok(group[i]!.left >= group[i - 1]!.right, `${width}px: timeline labels do not overlap`);
		assert.ok(labels.numbers.length < 40, "narrow bands omit their number");
		for (let n = 1; n <= 40; n++) {
			const band = page.locator(`[data-band="${n}"]`);
			await band.hover();
			assert.match(await page.locator(".arc-timeline > .arc-hint").innerText(), new RegExp(`Chapter ${n} ·`));
			await band.click();
			assert.equal(await page.locator(`[data-chapter="${n}"] .arc-chapter-row`).getAttribute("aria-expanded"), "true");
		}
		assert.equal(await page.getByRole("button", { name: "Show its 0 key points", exact: true }).count(), 0, "empty chapters have no key-point control");
		assert.ok(await page.getByRole("button", { name: "Show its 4 key points", exact: true }).count() > 0, "chapters with points retain their control");
		await page.locator(".arc-timeline").scrollIntoViewIfNeeded();
		for (const theme of ["light", "dark"]) {
			await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme); await frames(page);
			if (proof) await page.screenshot({ path: join(proof, `arc-forty-${theme}-${width}.png`) });
		}
	}
	assert.deepEqual(errors, []);
});
