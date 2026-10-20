import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
// @ts-ignore: the deploy scripts are plain ESM.
import { STAMP, webDistCurrent, writeStamp } from "../scripts/web-inputs.mjs";

// Demo and verify hubs serve web/dist as it is. The bundle also imports src/shared and src/pi/views, so a check of
// web/src alone passes a dist built before an edit there.

function put(root: string, rel: string, text: string) {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), text);
}

function checkout() {
	const root = mkdtempSync(join(tmpdir(), "ampi-web-stamp-"));
	put(root, "apps/ampi/web/src/main.tsx", "import './x';");
	put(root, "apps/ampi/src/shared/tool-state.ts", "export const a = 1;");
	put(root, "apps/ampi/web/dist/index.html", "<html></html>");
	return root;
}

test("web dist stamp: a dist matches its inputs until a bundled file outside web/src changes", (t) => {
	const root = checkout();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeStamp(root, join(root, "apps/ampi/web/dist"), ["apps/ampi/web/src/main.tsx", "apps/ampi/src/shared/tool-state.ts"]);
	assert.equal(webDistCurrent(root).ok, true, webDistCurrent(root).detail);

	put(root, "apps/ampi/src/shared/tool-state.ts", "export const a = 2;");
	const stale = webDistCurrent(root);
	assert.equal(stale.ok, false);
	assert.match(stale.detail, /apps\/ampi\/src\/shared\/tool-state\.ts/);
	assert.match(stale.detail, /npm run build:web -w @hypercarrier\/ampi/);
});

test("web dist stamp: a dist without a stamp or without index.html is refused with the build command", (t) => {
	const root = checkout();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const unstamped = webDistCurrent(root);
	assert.equal(unstamped.ok, false);
	assert.match(unstamped.detail, new RegExp(`${STAMP.replace(".", "\\.")}.*npm run build:web`));

	rmSync(join(root, "apps/ampi/web/dist"), { recursive: true });
	const missing = webDistCurrent(root);
	assert.equal(missing.ok, false);
	assert.match(missing.detail, /not built.*npm run build:web/);
});
