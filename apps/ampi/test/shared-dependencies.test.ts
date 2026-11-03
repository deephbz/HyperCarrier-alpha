import "./bound.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "src");
// Discover every producer directory, including future additions.
const producers = new Set(readdirSync(src, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && entry.name !== "shared")
	.map((entry) => entry.name));

function checkDependencies(directory: string, exceptions: Set<string>): void {
	const violations: string[] = [];
	const seen = new Set<string>();
	function scan(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) { scan(file); continue; }
			if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
			const text = readFileSync(file, "utf8");
			for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)["'](\.[^"']+)["']/g)) {
				const target = relative(src, resolve(dirname(file), match[1]!));
				const first = target.split("/")[0]!;
				if (first === ".." || first === "shared") continue;
				// Root source files are also outside the shared contract.
				if (!producers.has(first) && target.includes("/")) continue;
				const edge = `${relative(root, file)} -> src/${target}`;
				if (exceptions.has(edge)) seen.add(edge);
				else violations.push(`${edge}: move the value shape into shared/, or name an exception`);
			}
		}
	}
	scan(join(root, directory));
	assert.deepEqual(violations, [], violations.join("\n"));
	const stale = [...exceptions].filter((edge) => !seen.has(edge));
	assert.deepEqual(stale, [], `remove stale dependency exceptions: ${stale.join(", ")}`);
}

test("shared value types do not depend on producers", () => {
	checkDependencies("src/shared", new Set([
		// RarebitValue depends on RarebitItem, which the paused Arc builder imports from this producer.
		"src/shared/protocol.ts -> src/pi/views/rarebit.ts",
	]));
});

test("web values depend only on shared source contracts", () => {
	checkDependencies("web/src", new Set([
		// RarebitItem, RarebitValue and Kinds remain with the producer while Arc v2 is paused.
		"web/src/views/rarebit/View.tsx -> src/pi/views/rarebit.ts",
		"web/src/views/rarebit/Diagnosis.tsx -> src/pi/views/rarebit.ts",
	]));
});

test("AmPi imports chord only through @earendil-works/chord/delta (failure: a chord import outside delta returned with the durable node)", () => {
	const violations: string[] = [];
	function scan(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== "dist") scan(file); continue; }
			if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
			for (const match of readFileSync(file, "utf8").matchAll(/["'](@earendil-works\/chord(?:\/[^"']*)?)["']/g))
				if (match[1] !== "@earendil-works/chord/delta") violations.push(`${relative(root, file)}: ${match[1]}`);
		}
	}
	for (const dir of ["src", "web/src", "test", "scripts", "bin"]) scan(join(root, dir));
	assert.deepEqual(violations, [], violations.join("\n"));
});
