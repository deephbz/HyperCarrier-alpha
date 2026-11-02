import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

// The node tree (src/node, src/plugins) gains no runtime import cycle. A cycle makes module evaluation order decide
// which binding is still undefined; runtime.ts and guard.ts, and runtime.ts and accounts.ts, once imported each
// other, until NodeError and MetaDoc moved to leaf modules (errors.ts, meta-doc.ts).
//
// The edge model differs from test/web-import-cycles.test.ts. The web client is bundled, and its tsconfig erases an
// import whose named bindings are all types. The node runs its .ts files directly on Node, and Node's type stripping
// erases only `import type {…}` and `export type {…}`: it keeps `import { type X } from "./m.ts"` as an import of
// m.ts. So here a static relative import or re-export is an edge unless its whole clause is type-only. A dynamic
// import() loads after evaluation, so it is not an edge. The graph follows relative imports out of the two
// directories (into src/shared), because a cycle can pass through them.
//
// server.ts -> commands.ts -> plugins/rarebit.ts -> server.ts was the last cycle, until commands.ts reached the
// Rarebit command through the leaf plugins/rarebit-port.ts. KNOWN stays empty, so any cycle fails.

const src = resolve(import.meta.dirname, "../src");
const KNOWN: string[][] = [];

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		return e.isDirectory() ? sources(path) : /\.tsx?$/.test(e.name) ? [path] : [];
	});
}

/** The relative modules that `file` loads at runtime under Node type stripping. */
function runtimeImports(file: string): string[] {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
	const out: string[] = [];
	for (const node of source.statements) {
		let spec: ts.Expression | undefined;
		if (ts.isImportDeclaration(node)) {
			if (!node.importClause?.isTypeOnly) spec = node.moduleSpecifier;
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
			if (!node.isTypeOnly) spec = node.moduleSpecifier;
		}
		if (spec && ts.isStringLiteral(spec) && spec.text.startsWith(".")) out.push(resolve(dirname(file), spec.text));
	}
	return out.filter((path) => existsSync(path));
}

/** Each strongly connected component, by Tarjan's algorithm. */
function components(graph: Map<string, string[]>): string[][] {
	let next = 0;
	const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], onStack = new Set<string>(), found: string[][] = [];
	const visit = (v: string) => {
		index.set(v, next); low.set(v, next); next++;
		stack.push(v); onStack.add(v);
		for (const w of graph.get(v) ?? []) {
			if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
			else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
		}
		if (low.get(v) !== index.get(v)) return;
		const component: string[] = [];
		let w: string;
		do { w = stack.pop()!; onStack.delete(w); component.push(w); } while (w !== v);
		if (component.length > 1 || graph.get(v)!.includes(v)) found.push(component);
	};
	for (const v of graph.keys()) if (!index.has(v)) visit(v);
	return found;
}

/** The files of each cycle reachable from `roots`, relative to `base` and sorted. */
function findCycles(roots: string[], base: string): string[][] {
	const graph = new Map<string, string[]>();
	const queue = [...roots];
	while (queue.length) {
		const file = queue.pop()!;
		if (graph.has(file)) continue;
		const to = runtimeImports(file);
		graph.set(file, to);
		queue.push(...to);
	}
	return components(graph).map((c) => c.map((f) => relative(base, f)).sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
}

test("the graph model holds: Node loads a module named only by `import { type X }`, not by `import type`", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "node-import-cycles-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "kept.ts"), `export type K = 1;\nconsole.log("kept loaded");\n`);
	writeFileSync(join(dir, "erased.ts"), `export type E = 1;\nconsole.log("erased loaded");\n`);
	writeFileSync(join(dir, "main.ts"), `import { type K } from "./kept.ts";\nimport type { E } from "./erased.ts";\nconst k: K | E = 1;\nconsole.log(k);\n`);
	const loaded = execFileSync(process.execPath, [join(dir, "main.ts")], { encoding: "utf8" });
	assert.match(loaded, /kept loaded/, "Node keeps `import { type X }` as a module load");
	assert.doesNotMatch(loaded, /erased loaded/, "Node erases `import type`");
	assert.deepEqual(runtimeImports(join(dir, "main.ts")), [join(dir, "kept.ts")]);

	writeFileSync(join(dir, "a.ts"), `import { type B } from "./b.ts";\nexport type A = B[];\n`);
	writeFileSync(join(dir, "b.ts"), `import { type A } from "./a.ts";\nexport type B = { a?: A };\n`);
	writeFileSync(join(dir, "c.ts"), `import type { D } from "./d.ts";\nexport type C = D[];\n`);
	writeFileSync(join(dir, "d.ts"), `import type { C } from "./c.ts";\nexport type D = { c?: C };\n`);
	assert.deepEqual(findCycles(["a.ts", "c.ts"].map((f) => join(dir, f)), dir), [["a.ts", "b.ts"]]);
});

test("the node tree has no runtime import cycle", () => {
	const roots = [...sources(join(src, "node")), ...sources(join(src, "plugins"))];
	const cycles = findCycles(roots, src);
	assert.deepEqual(cycles, KNOWN,
		`src/node and src/plugins have runtime import cycles:\n${cycles.map((c) => `  ${c.join(", ")}`).join("\n")}\n`
		+ "Remedy: cut one value import on each new cycle, move the shared value into a leaf module below both files, or "
		+ "make the import `import type` when it names only types. If a known cycle was cut, remove it from KNOWN.");
});
