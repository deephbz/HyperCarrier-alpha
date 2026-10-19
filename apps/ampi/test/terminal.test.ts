import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";

const text = (v: any) => (v.chunks as { d: string }[]).map((c) => c.d).join("");

test("terminals: a node-owned shell outlives its client and replays scrollback to the next one", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home });
	try {
		const first = await TestClient.connect(daemon.socket);
		const term = await first.req("term.open", { cwd: home, cols: 100, rows: 30 });
		const sid = first.sub({ kind: "term", termId: term.id });
		await first.req("term.input", { termId: term.id, data: "echo pane-$((6*7))\r" });
		await first.until<any>(sid, (v) => /pane-42/.test(text(v)));
		// The client goes away (window closed, link dropped); the shell keeps running and keeps its output.
		await first.req("term.input", { termId: term.id, data: "sleep 0.3; echo while-detached\r" });
		first.close();
		await new Promise((r) => setTimeout(r, 600));
		const second = await TestClient.connect(daemon.socket);
		const list = await second.until<any>(second.sub({ kind: "terms" }), (v) => Object.keys(v.terms).length === 1);
		assert.equal(list.terms[term.id].cwd, home);
		const replay = await second.until<any>(second.sub({ kind: "term", termId: term.id }), (v) => /while-detached/.test(text(v)));
		assert.match(text(replay), /pane-42/, "earlier scrollback is replayed");
		await second.req("term.close", { termId: term.id });
		await second.until<any>(second.sub({ kind: "terms" }), (v) => Object.keys(v.terms).length === 0);
		assert.deepEqual(second.gaps, []);
		second.close();
	} finally {
		await daemon.stop();
	}
});
