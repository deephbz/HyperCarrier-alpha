import "./bound.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";

// web/dist holds build records next to the bundle (.web-inputs.json lists machine paths, .deploy-web-key). The hub
// serves the bundle only, so no dotfile leaves the machine.
test("hub static: dotfiles in web/dist are not served", async () => {
	const token = "d".repeat(64);
	const hub = new Hub({ hosts: [] }, { token });
	const port = await hub.listen(0);
	try {
		const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie: `ampi_k_${port}=${token}` } });
		for (const path of ["/.web-inputs.json", "/assets/.web-inputs.json", "/%2Eweb-inputs.json"]) {
			assert.equal((await get(path)).status, 404, path);
		}
		if (existsSync(join(import.meta.dirname, "..", "web", "dist", "index.html"))) {
			const index = await get("/");
			assert.equal(index.status, 200, "the bundle is still served");
			// A path without an extension is an app route, so it gets index.html, never the key file.
			assert.equal(await (await get("/.deploy-web-key")).text(), await index.text());
		}
	} finally {
		await hub.close();
	}
});
