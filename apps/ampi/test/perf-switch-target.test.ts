import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
// @ts-expect-error: a plain ESM script without types
import { SWITCH_TARGET } from "../scripts/perf/browser.mjs";

// The perf switch scenario clicks SWITCH_TARGET inside each sidebar row. A Pi Team Bright leader row toggles its Team
// group on a row click, so the target must be a link to the row's own Session in every row kind.

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let row: (props: object) => unknown;
let threadHref: (host: string, thread: string) => string;

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects.
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} } });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	row = (await vite.ssrLoadModule("/src/components/Sidebar.tsx")).ThreadRow;
	threadHref = (await vite.ssrLoadModule("/src/util.ts")).href.thread;
});
after(async () => { await vite?.close(); });

const session = (id: string, team?: object) => ({ id, title: id, cwd: "/synthetic", updatedAt: 1_760_000_000_000, activity: "idle", queued: 0, team });

test("perf switch target: leader, worker and plain rows each link their own Session", () => {
	const [tag, cls] = SWITCH_TARGET.split(".");
	const rows = {
		leader: { t: session("pi:lead", { teamId: "team-a", role: "lead" }), hasChildren: true, open: false, toggle() {}, workerCount: 1 },
		worker: { t: session("pi:w1", { teamId: "team-a", role: "worker", worker: "w1" }), child: true, navParentId: "pi:lead" },
		plain: { t: session("pi:solo") },
	};
	for (const [kind, props] of Object.entries(rows)) {
		const html = renderToStaticMarkup(createElement(row as never, { host: "devbox", active: false, ...props }));
		if (kind === "leader") assert.match(html, /data-leader-row="team-a"/, "the fixture renders a leader row");
		const target = new RegExp(`<${tag} class="${cls}" href="([^"]*)"`).exec(html);
		assert.ok(target, `${kind}: the row has a ${SWITCH_TARGET}`);
		assert.equal(target[1].replaceAll("&amp;", "&"), threadHref("devbox", props.t.id), `${kind}: ${SWITCH_TARGET} opens the row's own Session`);
	}
});
