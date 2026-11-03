import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configNotes } from "../src/doctor.ts";
import { loadHubConfig } from "../src/hub/hub.ts";
import { linkKey } from "../src/hub/hosts.ts";
import { hostSetupPrompt } from "../src/shared/host-setup.ts";

const dir = mkdtempSync(join(tmpdir(), "hub-config-"));
const at = (name: string, body: object) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(body)); return p; };
const links = (path: string) => loadHubConfig(path).hosts.map((h) => `${linkKey(h)} ${h.kind}`);

test("hub config: this machine is always a Pi Host, and no durable Host is implicit", () => {
	const self = process.env.AMPI_SELF ?? hostname();
	assert.deepEqual(links(join(dir, "missing.json")), [`${self}#pi pi-local`], "no hub.json");
	const remote = { hosts: [{ id: "linuxbox", label: "linuxbox", kind: "pi-ssh", target: "linuxbox.invalid" }] };
	assert.deepEqual(links(at("plain.json", { self: "box", ...remote })), ["box#pi pi-local", "linuxbox#pi pi-ssh"]);
	// The implicit Host resolves its paths from the environment at start; it names none, so a test home bounds it.
	assert.deepEqual(loadHubConfig(at("bare.json", { self: "box" })).hosts, [{ id: "box", label: "box", kind: "pi-local" }]);
});

test("hub config: a local or ssh row is a durable Host; the hub skips it, keeps it in hub.json, and reports it (failure: main served durable Hosts)", () => {
	const owner = {
		hosts: [
			{ id: "linuxbox", label: "linuxbox", kind: "pi-ssh", target: "linuxbox.invalid" },
			{ id: "mac", label: "mac", kind: "local", home: join(dir, "durable") },
			{ id: "linuxbox", label: "linuxbox", kind: "ssh", target: "linuxbox.invalid", command: "ampi bridge" },
		],
	};
	const config = loadHubConfig(at("owner.json", { self: "mac", ...owner }));
	assert.deepEqual(config.hosts.map((h) => `${linkKey(h)} ${h.kind}`), ["mac#pi pi-local", "linuxbox#pi pi-ssh"]);
	assert.deepEqual(config.skipped, [{ id: "mac", label: "mac", kind: "local" }, { id: "linuxbox", label: "linuxbox", kind: "ssh" }]);
	assert.equal(loadHubConfig(at("listed-pi.json", { hosts: [{ id: "mac", label: "mac", kind: "pi-local" }] })).skipped, undefined, "no durable row, no skipped list");
	assert.deepEqual(links(at("listed-pi.json", { hosts: [{ id: "mac", label: "mac", kind: "pi-local" }] })), ["mac#pi pi-local"], "a listed pi-local Host is the only one");
});

test("doctor notes: skipped durable Hosts and durable threads in the home each get one line", () => {
	const home = mkdtempSync(join(tmpdir(), "hub-config-home-"));
	assert.deepEqual(configNotes(home, []), []);
	const skipped = configNotes(home, [{ id: "mac", label: "mac", kind: "local" }]);
	assert.equal(skipped.length, 1);
	assert.equal(skipped[0]!.what, "hub.json lists durable Host mac (local); this hub serves Pi Hosts only and skips them");
	assert.match(skipped[0]!.fix, /release\/durable/);
	mkdirSync(join(home, "threads", "t-1"), { recursive: true });
	const lost = configNotes(home, []);
	assert.equal(lost.length, 1);
	assert.match(lost[0]!.what, /^1 durable thread in .*threads; this hub does not show them$/);
	assert.match(lost[0]!.fix, /same AMPI_HOME/);
});

test("host setup prompt: the agent edits the hub.json this hub reads, adds a Pi Host, restarts the hub (it reads hub.json only at start), and checks the Host connects (failure: the prompt named the default path; the agent's shell lacks the hub's AMPI_HOME)", () => {
	const prompt = hostSetupPrompt("/srv/hub-home/hub.json");
	assert.match(prompt, /edit \/srv\/hub-home\/hub\.json \(the file this hub reads\)/);
	assert.match(prompt, /"kind": "pi-ssh"/);
	assert.match(prompt, /Restart the AmPi hub/);
	assert.match(prompt, /Ask me to confirm that <alias> shows as connected/, "the agent cannot see the sidebar");
	assert.doesNotMatch(prompt, /backend/);
	assert.match(hostSetupPrompt(), /hub\.json in AMPI_HOME \(default ~\/\.ampi\/hub\.json\)/, "a hub with no config path names the default");
});
