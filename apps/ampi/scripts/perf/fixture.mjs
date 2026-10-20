// Perf fixtures: frozen AMPI_HOME snapshots outside Git, cloned per run with APFS clonefile (`cp -c`).
//
// <PERF_HOME>/fixtures/<id>/
//   manifest.json   id, kind, frozenAt, counts; never secrets
//   sources/<n>/    frozen copies of every Session root the snapshot references; sources/0 is the Pi agent dir
//   herdr/          a read-only Herdr replay: recorded list answers, every write verb refused
//   home-cold/      AMPI_HOME before the first derivation (replicas + index.json): cloned for the `index` scenario
//   home/           AMPI_HOME after the warm fill: every other scenario runs in it, in place, under the run lock
//
// Warm runs cannot use a clone: the range reader keys its index on each replica's absolute path and inode, and a
// clone changes both, so every clone starts cold. The fill therefore runs at home/ itself. The sources are frozen,
// so the warm home converges; `fixture <id>` remakes it. Session recency is a clock comparison; each run sets
// recentMs = 4 days + (now - frozenAt), so the retained set stays fixed.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { PERF_HOME } from "./lock.mjs";

export const FIXTURES = join(PERF_HOME, "fixtures");
export const RECENT_MS = 4 * 86_400_000;

export function fixtureDir(id) {
	return join(FIXTURES, id);
}

export function readManifest(id) {
	const file = join(fixtureDir(id), "manifest.json");
	if (!existsSync(file)) throw new Error(`No perf fixture "${id}". Make it with: npm run perf -- fixture ${id}`);
	return JSON.parse(readFileSync(file, "utf8"));
}

/** A fresh cold AMPI_HOME at `target`, cloned from home-cold (copy-on-write). */
export function cloneColdHome(id, target) {
	const source = join(fixtureDir(id), "home-cold");
	if (!existsSync(source)) throw new Error(`Perf fixture "${id}" has no home-cold; remake it`);
	rmSync(target, { recursive: true, force: true });
	execFileSync("cp", ["-c", "-R", source, target]);
}

/** Sets each host's recent window so the fixture's frozen Sessions count as recent at this run's clock. */
export function prepareHome(id, home) {
	const manifest = readManifest(id);
	if (!existsSync(join(home, "hub.json"))) throw new Error(`No AmPi home at ${home}; make it with: npm run perf -- fixture ${id}`);
	rmSync(join(home, "hub.port"), { force: true });
	const configPath = join(home, "hub.json");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	for (const host of config.hosts) host.recentMs = RECENT_MS + Math.max(0, Date.now() - manifest.frozenAt);
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	return manifest;
}

const REPLAY = `#!/bin/sh
# Read-only Herdr replay for AmPi perf runs. Recorded list answers; every other verb is refused.
d=$(dirname "$0")
[ "$1" = "--version" ] && { cat "$d/version.txt"; exit 0; }
[ "$1" = "--session" ] && shift 2
case "$1 $2" in
	"session list") cat "$d/session-list.json" ;;
	"workspace list") cat "$d/workspace-list.json" ;;
	"tab list") cat "$d/tab-list.json" ;;
	"agent list") cat "$d/agent-list.json" ;;
	"agent read") echo '{"result":{"text":""}}' ;;
	*) echo '{"error":{"code":"perf_replay_read_only","message":"the perf fixture replays Herdr reads only"}}'; exit 1 ;;
esac
`;

function writeReplay(dir, recorded) {
	mkdirSync(dir, { recursive: true });
	for (const [name, value] of Object.entries(recorded)) writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
	writeFileSync(join(dir, "herdr"), REPLAY);
	chmodSync(join(dir, "herdr"), 0o755);
	return join(dir, "herdr");
}

const READ_ONLY = new Set(["--version", "session list", "workspace list", "tab list", "agent list"]);

/** Records the read-only Herdr answers the remote agent's discovery uses. Refuses any other verb. */
function recordHerdr(herdr, session, mapPath) {
	const run = (argv) => {
		const verb = argv[0] === "--session" ? argv.slice(2, 4).join(" ") : argv[0] === "--version" ? "--version" : argv.slice(0, 2).join(" ");
		if (!READ_ONLY.has(verb)) throw new Error(`refusing to record herdr ${verb}`);
		return execFileSync(herdr, argv, { encoding: "utf8", timeout: 10_000 });
	};
	const version = run(["--version"]);
	const sessions = JSON.parse(run(["session", "list", "--json"]));
	// A scoped call can start a missing server, so only a running session is asked for its lists.
	const running = sessions.sessions?.some((s) => s.name === session && s.running === true);
	const empty = (key) => ({ result: { [key]: [] } });
	const workspaces = running ? JSON.parse(run(["--session", session, "workspace", "list"])) : empty("workspaces");
	const tabs = running ? JSON.parse(run(["--session", session, "tab", "list"])) : empty("tabs");
	const agents = running ? JSON.parse(run(["--session", session, "agent", "list"])) : empty("agents");
	let unfrozen = 0;
	for (const agent of agents.result?.agents ?? []) {
		if (agent.agent_session?.kind !== "path") continue;
		const frozen = mapPath(agent.agent_session.value);
		// A pane whose Session lives outside the frozen roots would make the agent read a live file.
		if (frozen) agent.agent_session.value = frozen;
		else {
			delete agent.agent_session;
			unfrozen++;
		}
	}
	return { recorded: { "version.txt": version, "session-list.json": sessions, "workspace-list.json": workspaces, "tab-list.json": tabs, "agent-list.json": agents }, unfrozen, panes: agents.result?.agents?.length ?? 0 };
}

/** The Host's cache dir name (PiHost constructor). */
const hostDigest = (id) => createHash("sha256").update(id).digest("hex").slice(0, 16);

const sessionsRoot = (path) => {
	const at = path.indexOf("/sessions/");
	return at < 0 ? undefined : path.slice(0, at + "/sessions".length);
};

/**
 * Freezes an owner AMPI_HOME (`from`) and every Session root its copies name. Sessions under the Pi agent dir become
 * sources/0, so the agent's recent-file walk sees the frozen tree.
 */
export function makeOwnerFixture({ id = "owner", from, agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), herdr, log = console.error }) {
	const root = fixtureDir(id);
	const building = `${root}.building`;
	rmSync(building, { recursive: true, force: true });
	mkdirSync(building, { recursive: true });
	const frozenAt = Date.now();
	const config = JSON.parse(readFileSync(join(from, "hub.json"), "utf8"));
	// The hub adds an implicit pi-local Host named `self` (default: hostname). Pin it, so the copies' cache dir (a
	// digest of the Host ID) stays valid on any machine. SSH Hosts would read live remote data: drop them and their caches.
	const self = config.self ?? hostname();
	const host = (config.hosts ?? []).find((h) => h.kind === "pi-local") ?? { id: self, label: self, kind: "pi-local" };
	config.hosts = [host];
	config.self = host.id;
	const cache = hostDigest(host.id);
	const indexes = [join(from, "pi-cache", cache, "index.json")].filter(existsSync);
	if (!indexes.length) throw new Error(`The source home has no copies for its pi-local Host (pi-cache/${cache})`);
	const roots = [join(agentDir, "sessions")];
	for (const file of indexes) for (const path of Object.keys(JSON.parse(readFileSync(file, "utf8")))) {
		const r = sessionsRoot(path);
		if (r && !roots.includes(r)) roots.push(r);
	}
	const frozenRoots = roots.map((_, n) => join(building, "sources", String(n), "sessions"));
	roots.forEach((r, n) => {
		mkdirSync(join(frozenRoots[n], ".."), { recursive: true });
		if (existsSync(r)) execFileSync("cp", ["-c", "-R", r, frozenRoots[n]]);
		else mkdirSync(frozenRoots[n]);
		log(`froze Session root ${n}`);
	});
	const final = (path) => path.replace(building, root);
	const mapPath = (path) => {
		const n = roots.findIndex((r) => path.startsWith(`${r}/`));
		return n < 0 ? undefined : final(frozenRoots[n]) + path.slice(roots[n].length);
	};
	// Home: rewrite each copy's key to its frozen path; replica files keep their names.
	const home = join(building, "home-cold");
	mkdirSync(join(home, "pi-cache"), { recursive: true, mode: 0o700 });
	execFileSync("cp", ["-c", "-R", join(from, "pi-cache", cache), join(home, "pi-cache", cache)]);
	if (existsSync(join(from, "hub.token"))) execFileSync("cp", [join(from, "hub.token"), join(home, "hub.token")]);
	let copies = 0, outside = 0;
	for (const dir of readdirSync(join(home, "pi-cache"))) {
		const file = join(home, "pi-cache", dir, "index.json");
		if (!existsSync(file)) continue;
		const index = JSON.parse(readFileSync(file, "utf8"));
		const next = {};
		for (const [path, meta] of Object.entries(index)) {
			const frozen = mapPath(path);
			if (!frozen) outside++;
			next[frozen ?? path] = meta;
			copies++;
		}
		writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
		for (const name of readdirSync(join(home, "pi-cache", dir))) if (name.includes(".sqlite")) rmSync(join(home, "pi-cache", dir, name), { force: true });
	}
	const herdrBin = herdr ?? [join(homedir(), ".local", "bin", "herdr")].find(existsSync) ?? "herdr";
	const { recorded, unfrozen, panes } = recordHerdr(herdrBin, host.herdrSession ?? "default", mapPath);
	writeReplay(join(building, "herdr"), recorded);
	host.agentConfig = { ...host.agentConfig, agentDir: join(root, "sources", "0") };
	host.env = { ...host.env, HERDR_BIN: join(root, "herdr", "herdr") };
	writeFileSync(join(home, "hub.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	const manifest = { id, kind: "owner", frozenAt, createdAt: new Date(frozenAt).toISOString(), copies, copiesOutsideRoots: outside, roots: roots.length, panes, panesOutsideRoots: unfrozen, filled: false };
	writeFileSync(join(building, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	rmSync(root, { recursive: true, force: true });
	renameSync(building, root);
	return manifest;
}

// ---- synthetic ----

function prng(seed) {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const WORDS = "alpha beta gamma delta build test cache index session render worker thread query report trace merge stage layout window switch".split(" ");

/** Generated Pi Sessions: no owner data, deterministic, small enough for sub-second loops and CI. */
export function makeSyntheticFixture({ id = "synthetic", sessions = 40, entries = 200, live = 4 } = {}) {
	const root = fixtureDir(id);
	const building = `${root}.building`;
	rmSync(building, { recursive: true, force: true });
	const sessionsDir = join(building, "sources", "0", "sessions", "--synthetic-project--");
	mkdirSync(sessionsDir, { recursive: true });
	const random = prng(42);
	const text = (n) => Array.from({ length: n }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");
	const frozenAt = Date.now();
	const files = [];
	for (let s = 0; s < sessions; s++) {
		const sessionId = `00000000-0000-4000-8000-${String(s).padStart(12, "0")}`;
		const start = frozenAt - (sessions - s) * 3_600_000;
		const lines = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(start).toISOString(), cwd: "/synthetic/project" })];
		let parent = null;
		for (let e = 0; e < entries; e++) {
			const at = start + e * 5_000, user = e % 2 === 0, entryId = `e${s}-${e}`;
			const message = user
				? { role: "user", content: [{ type: "text", text: text(12 + Math.floor(random() * 40)) }], timestamp: at }
				: { role: "assistant", content: [{ type: "text", text: text(40 + Math.floor(random() * 200)) }], model: "synthetic-model", stopReason: "stop", usage: { input: 1000 + e, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, timestamp: at };
			lines.push(JSON.stringify({ type: "message", id: entryId, parentId: parent, timestamp: new Date(at).toISOString(), message }));
			parent = entryId;
		}
		const file = join(sessionsDir, `${new Date(start).toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
		writeFileSync(file, `${lines.join("\n")}\n`);
		files.push(file);
	}
	const final = (path) => path.replace(building, root);
	const agents = files.slice(-live).map((file, n) => ({ pane_id: `p${n}`, workspace_id: "w1", tab_id: "t1", name: `synthetic-${n}`, agent: "pi", agent_status: "idle", cwd: "/synthetic/project", focused: false, agent_session: { kind: "path", agent: "pi", value: final(file) } }));
	writeReplay(join(building, "herdr"), {
		"version.txt": "herdr 0.0.0-perf-synthetic\n",
		"session-list.json": { sessions: [{ name: "default", running: true }] },
		"workspace-list.json": { result: { workspaces: [{ workspace_id: "w1", label: "synthetic" }] } },
		"tab-list.json": { result: { tabs: [{ tab_id: "t1", workspace_id: "w1", label: "synthetic" }] } },
		"agent-list.json": { result: { agents } },
	});
	const home = join(building, "home-cold");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const host = { id: "synthetic", label: "synthetic", kind: "pi-local", herdrSession: "default", agentConfig: { agentDir: join(root, "sources", "0") }, env: { HERDR_BIN: join(root, "herdr", "herdr") } };
	writeFileSync(join(home, "hub.json"), `${JSON.stringify({ backend: "pi", self: "synthetic", hosts: [host], models: { arcLabels: "anthropic/claude-haiku-5-5", arcSynthesis: "anthropic/claude-sonnet-5-5", rarebitRecap: "anthropic/claude-haiku-5-5", rarebitAsk: "anthropic/claude-sonnet-5-5" } }, null, 2)}\n`, { mode: 0o600 });
	writeFileSync(join(home, "hub.token"), `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
	const manifest = { id, kind: "synthetic", frozenAt, createdAt: new Date(frozenAt).toISOString(), copies: 0, sessions, entries, panes: live, filled: false };
	writeFileSync(join(building, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	rmSync(root, { recursive: true, force: true });
	renameSync(building, root);
	return manifest;
}

/** Records the fill in the manifest. The fill ran in the fixture's `home`, so that home is now warm. */
export function recordFill(id, stats) {
	const root = fixtureDir(id);
	const manifest = { ...readManifest(id), filled: true, filledAt: new Date().toISOString(), fill: stats };
	writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

export function fixtureBytes(id) {
	const out = execFileSync("du", ["-sk", fixtureDir(id)], { encoding: "utf8" });
	return Number(out.split(/\s/)[0]) * 1024;
}

