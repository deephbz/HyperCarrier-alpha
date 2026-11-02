import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import type { TeamValue } from "../src/shared/team.ts";
import { Browser } from "./helpers.ts";
import { fixture } from "./pi-fixtures.ts";

test("Team view: public Tasks arrive and update independently of Session bytes; stopped Memberships keep exact Session links", async t => {
	const f = fixture();
	const token = "e".repeat(64);
	const dataFile = join(f.dir, "ptb.json"), moduleFile = join(f.dir, "observation.mjs");
	const member = (team: string, name: string, session: string, pane: string, role = "teammate") => ({ teamName: team, memberName: name, coordinationRole: role, membershipId: `${team}/${name}`, lifecycle: { state: "current" }, session: { kind: "pi-jsonl-path", locator: session }, terminalTarget: { backend: "herdr", kind: "pane", targetId: pane } });
	const data = {
		schema: "pi-teams-observation/1", availability: "available", issues: [], missingReader: false,
		teams: [
			{ teamName: "alpha", issues: [], memberships: [member("alpha", "lead", f.sessionA, "w1:p2", "lead"), member("alpha", "worker", f.sessionB, "w1:p1")] },
			{ teamName: "beta", issues: [], memberships: [] },
		],
		tasks: { alpha: { schema: "pi-team-tasks/1", teamName: "alpha", availability: "available", issues: [] as string[], tasks: [{ id: "A", title: "Read 日本語", status: "ready", owner: "worker", deps: [] as string[], ready: true }] }, beta: { schema: "pi-team-tasks/1", teamName: "beta", availability: "available", issues: [], tasks: [] } },
	};
	const save = () => writeFileSync(dataFile, JSON.stringify(data)); save();
	writeFileSync(moduleFile, `import fs from 'node:fs';
const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(dataFile)}, 'utf8'));
export let readTaskSnapshot = ({teamName}) => read().tasks[teamName];
export async function readObservationSnapshot() { const data = read(); readTaskSnapshot = data.missingReader ? undefined : ({teamName}) => read().tasks[teamName]; return data; }`);
	const header = (id: string) => `${JSON.stringify({ type: "session", version: 3, id, cwd: "/work", timestamp: new Date().toISOString() })}\n`;
	writeFileSync(f.sessionA, header("sess-a")); writeFileSync(f.sessionB, header("sess-b"));
	const hub = new Hub({ hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: join(f.dir, "cache"),
		agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 180, teamsMs: 150, ptbObservation: moduleFile },
		env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") } }] }, { token });
	const port = await hub.listen(0);
	const browser = await Browser.open(port, undefined, `ampi_k_${port}=${token}`);
	t.after(async () => { browser.ws.close(); await hub.close(); });
	const all = browser.sub("devbox", { kind: "view", view: "team" });
	const alpha = browser.sub("devbox", { kind: "view", view: "team", threadId: "pi:sess-a" });
	const first = await browser.until<TeamValue>(alpha, v => v.teams[0]?.members[1]?.threadId === "pi:sess-b" && v.teams[0]?.tasks.length === 1
		// Liveness arrives from Herdr on its own schedule: wait for it rather than racing it.
		&& v.teams[0]?.members[0]?.status === "streaming" && v.teams[0]?.members[1]?.status === "idle");
	assert.deepEqual(first, { availability: "available", teams: [{ name: "alpha", members: [
		{ member: "lead", role: "lead", threadId: "pi:sess-a", ref: "devbox/pi:sess-a", pane: "w1:p2", live: true, status: "streaming" },
		{ member: "worker", role: "teammate", threadId: "pi:sess-b", ref: "devbox/pi:sess-b", pane: "w1:p1", live: true, status: "idle" },
	], tasks: data.tasks.alpha.tasks, messages: { availability: "unavailable", reason: "Messages unavailable for Pi Teams: this Host publishes membership and Tasks only." }, issues: [] }] });
	assert.equal((await browser.until<TeamValue>(all, v => v.teams.length === 2)).teams[1]!.name, "beta");
	// A Task-only authority update must reach both subscriptions, with no Session append.
	data.tasks.alpha.tasks[0]!.status = "blocked"; data.tasks.alpha.tasks[0]!.ready = false;
	data.tasks.alpha.tasks.push({ id: "B", title: "Verify the read", status: "dependency_waiting", owner: "lead", deps: ["A"], ready: false }); save();
	assert.deepEqual((await browser.until<TeamValue>(alpha, v => v.teams[0]?.tasks.length === 2)).teams[0]!.tasks, data.tasks.alpha.tasks);
	await browser.until<TeamValue>(all, v => v.teams[0]?.tasks[0]?.status === "blocked");
	// Membership survives process/pane absence; liveness does not.
	f.setState({ ...f.state, agents: f.state.agents.filter((a: any) => a.pane_id !== "w1:p1") });
	const stopped = await browser.until<TeamValue>(alpha, v => v.teams[0]?.members[1]?.live === false);
	assert.deepEqual(stopped.teams[0]!.members[1], { member: "worker", role: "teammate", threadId: "pi:sess-b", ref: "devbox/pi:sess-b", pane: "w1:p1", live: false, status: "not running" });
	// A closed member keeps its Team in its summary and its Timeline lane, so the Timeline groups it with its lead.
	const closed = await browser.until<any>(browser.sub("devbox", { kind: "threads" }), v => v.threads["pi:sess-b"]?.live === false);
	assert.deepEqual(closed.threads["pi:sess-b"].team, { teamId: "alpha", role: "worker", worker: "worker" });
	const lanes = await browser.until<any>(browser.sub("devbox", { kind: "view", view: "cos.timeline" }), v => v.sessions.some((s: any) => s.threadId === "pi:sess-b"));
	assert.equal(lanes.sessions.find((s: any) => s.threadId === "pi:sess-b").team, "alpha");
	// PTB can explicitly end a Membership on process shutdown; recorded identity still survives.
	data.teams[0]!.memberships[1]!.lifecycle.state = "ended";
	data.tasks.alpha.tasks[0]!.title = "Read after the worker stopped"; save();
	const ended = await browser.until<TeamValue>(alpha, v => v.teams[0]?.tasks[0]?.title === "Read after the worker stopped");
	assert.deepEqual(ended.teams[0]!.members[1], stopped.teams[0]!.members[1]);
	appendFileSync(f.sessionA, `${JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Check the Task" }] } })}\n`);
	await browser.until<any>(browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" }), v => v.entries.length === 1);
	// Never relabel an unavailable graph as empty, or retain its Tasks as fresh.
	data.tasks.alpha.availability = "unavailable"; data.tasks.alpha.issues = ["task_authority_unavailable"]; save();
	const unavailable = await browser.until<TeamValue>(alpha, v => v.teams[0]?.issues.includes("task_authority_unavailable") === true);
	assert.equal(unavailable.teams[0]!.tasks.length, 0);
	data.tasks.alpha.availability = "available"; data.tasks.alpha.issues = []; data.tasks.alpha.tasks = []; save();
	await browser.until<TeamValue>(alpha, v => v.teams[0]?.tasks.length === 0 && v.teams[0]?.issues.length === 0);
	data.missingReader = true; save();
	await browser.until<TeamValue>(alpha, v => v.teams[0]?.issues.includes("task_reader_missing") === true);
	data.availability = "unavailable"; save();
	await browser.until<TeamValue>(alpha, v => v.availability === "unavailable" && v.teams[0]?.members.length === 2);
	assert.equal(browser.snaps.get(alpha), 1, "updates use the existing subscription");
	assert.deepEqual(browser.gaps, []);
});

test("Team view: the threads frame pins each copy's Team label and pane location from recorded members and the layout", async t => {
	const f = fixture();
	const token = "e".repeat(64);
	const moduleFile = join(f.dir, "observation.mjs");
	const sessions = join(f.agentDir, "sessions", "--work--");
	const [sessionC, sessionD, sessionE] = ["c", "d", "e"].map((name) => join(sessions, `${name}.jsonl`)) as [string, string, string];
	const member = (team: string, name: string, session: string, role = "teammate", pane?: string) => ({ teamName: team, memberName: name, coordinationRole: role, membershipId: `${team}/${name}`, lifecycle: { state: "current" }, session: { kind: "pi-jsonl-path", locator: session }, ...(pane ? { terminalTarget: { backend: "herdr", kind: "pane", targetId: pane } } : {}) });
	// A: live lead in its pane. B: live pane, recorded worker. C: recorded twice in one Team, lead listed second.
	// D: recorded in two Teams, so unlabeled. E: no Team. A Membership whose Session is not a copy labels nothing.
	const data = { schema: "pi-teams-observation/1", availability: "available", issues: [], teams: [
		{ teamName: "alpha", issues: [], memberships: [member("alpha", "lead", f.sessionA, "lead", "w1:p2"), member("alpha", "worker", f.sessionB), member("alpha", "gone", join(sessions, "gone.jsonl"))] },
		{ teamName: "beta", issues: [], memberships: [member("beta", "helper", sessionC), member("beta", "boss", sessionC, "lead"), member("beta", "d1", sessionD)] },
		{ teamName: "gamma", issues: [], memberships: [member("gamma", "d2", sessionD)] },
	] };
	writeFileSync(moduleFile, `export const readTaskSnapshot = ({teamName}) => ({ schema: 'pi-team-tasks/1', teamName, availability: 'available', issues: [], tasks: [] });
export async function readObservationSnapshot() { return ${JSON.stringify(data)}; }`);
	const header = (id: string) => `${JSON.stringify({ type: "session", version: 3, id, cwd: "/work", timestamp: new Date().toISOString() })}\n`;
	for (const [file, id] of [[f.sessionA, "sess-a"], [f.sessionB, "sess-b"], [sessionC, "sess-c"], [sessionD, "sess-d"], [sessionE, "sess-e"]] as const) writeFileSync(file, header(id));
	const hub = new Hub({ hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: join(f.dir, "cache"),
		agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 180, teamsMs: 150, ptbObservation: moduleFile },
		env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") } }] }, { token });
	const port = await hub.listen(0);
	const browser = await Browser.open(port, undefined, `ampi_k_${port}=${token}`);
	t.after(async () => { browser.ws.close(); await hub.close(); });
	const value = await browser.until<any>(browser.sub("devbox", { kind: "threads" }), v => ["a", "b", "c", "d", "e"].every((s) => v.threads[`pi:sess-${s}`]) && v.threads["pi:sess-a"].team && v.threads["pi:sess-c"].team);
	// The exact bytes of the fields that host inputs project.
	const pinned = Object.fromEntries(Object.entries(value.threads).map(([id, s]: [string, any]) => [id, JSON.stringify([s.team, s.location])]));
	const pane = (p: string) => ({ workspace: "w1", workspaceLabel: "alpha", tab: "w1:tA", tabLabel: "main", pane: p });
	assert.deepEqual(pinned, {
		"pi:sess-a": JSON.stringify([{ teamId: "alpha", role: "lead", worker: "lead" }, pane("w1:p2")]),
		"pi:sess-b": JSON.stringify([{ teamId: "alpha", role: "worker", worker: "worker" }, pane("w1:p1")]),
		"pi:sess-c": JSON.stringify([{ teamId: "beta", role: "lead", worker: "boss" }, null]),
		"pi:sess-d": "[null,null]",
		"pi:sess-e": "[null,null]",
	});
});
