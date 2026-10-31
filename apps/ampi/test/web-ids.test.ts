import "./bound.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { newId } from "../web/src/ids.ts";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("newId mints distinct RFC 4122 version 4 UUIDs", () => {
	const ids = Array.from({ length: 2000 }, newId);
	for (const id of ids) assert.match(id, V4);
	assert.equal(new Set(ids).size, ids.length);
});

test("newId works where crypto.randomUUID does not exist (an insecure context)", (t) => {
	const own = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
	const proto = Object.getPrototypeOf(crypto);
	const inherited = Object.getOwnPropertyDescriptor(proto, "randomUUID");
	if (own) delete (crypto as { randomUUID?: unknown }).randomUUID;
	if (inherited) delete proto.randomUUID;
	t.after(() => {
		if (own) Object.defineProperty(crypto, "randomUUID", own);
		if (inherited) Object.defineProperty(proto, "randomUUID", inherited);
	});
	assert.equal(typeof (crypto as { randomUUID?: unknown }).randomUUID, "undefined");
	assert.match(newId(), V4);
});

// The web app runs in insecure contexts, so no web source may call randomUUID; ids.ts owns id minting.
test("no web source calls randomUUID", () => {
	const root = fileURLToPath(new URL("../web/src", import.meta.url));
	const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f));
	assert.ok(files.length > 20, "the scan sees the web sources");
	const callers = files.filter((f) => /randomUUID/.test(readFileSync(join(root, f), "utf8")));
	assert.deepEqual(callers, [], "use newId() from web/src/ids.ts");
});
