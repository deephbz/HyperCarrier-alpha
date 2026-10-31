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

test("hub config: this machine is always a Pi Host, no durable Host is implicit, and an old backend field changes nothing (failure: Pi Sessions showed only with backend pi)", () => {
	const self = process.env.AMPI_SELF ?? hostname();
	assert.deepEqual(links(join(dir, "missing.json")), [`${self}#pi pi-local`], "no hub.json");
	const remote = { hosts: [{ id: "linuxbox", label: "linuxbox", kind: "pi-ssh", target: "linuxbox.invalid" }] };
	assert.deepEqual(links(at("plain.json", { self: "box", ...remote })), ["box#pi pi-local", "linuxbox#pi pi-ssh"]);
	assert.deepEqual(links(at("legacy.json", { backend: "pi", self: "box", ...remote })), ["box#pi pi-local", "linuxbox#pi pi-ssh"], "backend pi");
	assert.deepEqual(links(at("legacy-node.json", { backend: "node", self: "box", ...remote })), ["box#pi pi-local", "linuxbox#pi pi-ssh"], "backend node");
	const saved = process.env.AMPI_BACKEND;
	process.env.AMPI_BACKEND = "node";
	try {
		assert.deepEqual(links(at("env.json", { self: "box" })), ["box#pi pi-local"], "AMPI_BACKEND");
	} finally {
		if (saved === undefined) delete process.env.AMPI_BACKEND;
		else process.env.AMPI_BACKEND = saved;
	}
	// The implicit Host resolves its paths from the environment at start; it names none, so a test home bounds it.
	assert.deepEqual(loadHubConfig(at("bare.json", { self: "box" })).hosts, [{ id: "box", label: "box", kind: "pi-local" }]);
});

test("hub config: listed durable Hosts still load, and one Host ID keeps both sources (the owner's shape gives four links)", () => {
	const owner = {
		backend: "pi",
		hosts: [
			{ id: "linuxbox", label: "linuxbox", kind: "pi-ssh", target: "linuxbox.invalid" },
			{ id: "mac", label: "mac", kind: "local", home: join(dir, "durable") },
			{ id: "linuxbox", label: "linuxbox", kind: "ssh", target: "linuxbox.invalid", command: "ampi bridge" },
		],
	};
	assert.deepEqual(links(at("owner.json", { self: "mac", ...owner })), ["mac#pi pi-local", "linuxbox#pi pi-ssh", "mac#durable local", "linuxbox#durable ssh"]);
	assert.deepEqual(links(at("listed-pi.json", { hosts: [{ id: "mac", label: "mac", kind: "pi-local" }] })), ["mac#pi pi-local"], "a listed pi-local Host is the only one");
});

test("doctor notes: a backend field, AMPI_BACKEND, and durable threads without a listed durable Host each get one line", () => {
	const home = mkdtempSync(join(tmpdir(), "hub-config-home-"));
	assert.deepEqual(configNotes({}, {}, home, [], "mac"), []);
	assert.deepEqual(configNotes({ backend: "pi" }, { AMPI_BACKEND: "pi" }, home, [], "mac").map((n) => n.what), ['hub.json sets "backend"; the hub ignores it', "AMPI_BACKEND is set; the hub ignores it"]);
	mkdirSync(join(home, "threads", "t-1"), { recursive: true });
	const lost = configNotes({}, {}, home, [{ kind: "pi-local" }], "mac");
	assert.equal(lost.length, 1);
	assert.match(lost[0]!.what, /^1 durable thread in .*threads, and no durable Host is listed/);
	assert.match(lost[0]!.fix, /\{ "id": "mac", "label": "mac", "kind": "local" \}/, "the durable Host takes this machine's Host ID");
	assert.deepEqual(configNotes({}, {}, home, [{ kind: "pi-local" }, { kind: "local" }], "mac"), [], "a listed durable Host serves them");
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
