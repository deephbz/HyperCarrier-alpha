import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

// The web client has no runtime import cycle. A cycle makes module evaluation order decide which binding is still
// undefined; util.ts and nav.ts, and Sidebar.tsx and PiSidebar.tsx, once imported each other. The check covers all of
// web/src, views/arc/ included. Its model of a runtime edge: a static relative import or re-export. Type-only imports
// and exports are erased because web/tsconfig.json leaves verbatimModuleSyntax off; the test asserts that setting.
// A dynamic import() loads after evaluation, so it is not an edge.

const web = resolve(import.meta.dirname, "../web/src");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		return e.isDirectory() ? sources(path) : /\.tsx?$/.test(e.name) ? [path] : [];
	});
}

/** The relative modules that `file` loads at runtime. */
function runtimeImports(file: string): string[] {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
	const out: string[] = [];
	for (const node of source.statements) {
		let spec: ts.Expression | undefined;
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			const typeOnly = clause !== undefined && (clause.isTypeOnly
				|| (!clause.name && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly)));
			if (!typeOnly) spec = node.moduleSpecifier;
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
			const clause = node.exportClause;
			const typeOnly = node.isTypeOnly || (clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly));
			if (!typeOnly) spec = node.moduleSpecifier;
		}
		if (spec && ts.isStringLiteral(spec) && spec.text.startsWith(".")) out.push(resolve(dirname(file), spec.text));
	}
	return out;
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

/** One cycle through the component's first file, in import order, by a shortest path back to it. */
function cycleOf(graph: Map<string, string[]>, component: string[]): string[] {
	const inside = new Set(component), start = [...component].sort()[0]!;
	const from = new Map<string, string>();
	const queue = [start];
	while (queue.length) {
		const v = queue.shift()!;
		for (const w of graph.get(v)!) {
			if (!inside.has(w)) continue;
			if (w === start) {
				const path = [v];
				while (path[0] !== start) path.unshift(from.get(path[0]!)!);
				return path;
			}
			if (!from.has(w)) { from.set(w, v); queue.push(w); }
		}
	}
	throw new Error(`no cycle through ${start}`);
}

/** Each tangle of runtime import cycles under `dir`: one cycle in import order, and the other files on its cycles. */
function findCycles(dir: string): { cycle: string[]; also: string[] }[] {
	const files = sources(dir);
	const known = new Set(files);
	const graph = new Map(files.map((f) => [f, runtimeImports(f).filter((to) => known.has(to))]));
	return components(graph).map((c) => {
		const cycle = cycleOf(graph, c);
		return { cycle: cycle.map((f) => relative(dir, f)), also: c.filter((f) => !cycle.includes(f)).map((f) => relative(dir, f)).sort() };
	});
}

function cycleReport(cycles: { cycle: string[]; also: string[] }[]): string {
	return `web/src has ${cycles.length} runtime import cycle(s):\n`
		+ cycles.map(({ cycle, also }) => `  ${[...cycle, cycle[0]].join(" -> ")}\n${also.length ? `    other files on its cycles: ${also.join(", ")}\n` : ""}`).join("")
		+ "Remedy: cut one value import on each cycle, move the shared value into a module below both files, or make the import `import type` when it names only types.";
}

test("the graph model holds: verbatimModuleSyntax is off, a value cycle is found, a type-only pair is not", (t) => {
	const config = ts.readConfigFile(resolve(web, "../tsconfig.json"), ts.sys.readFile);
	assert.ok(!config.error && config.config.compilerOptions.verbatimModuleSyntax !== true,
		"web/tsconfig.json turned on verbatimModuleSyntax: a type-only named import now emits a runtime import, so runtimeImports must count it");
	const dir = mkdtempSync(join(tmpdir(), "web-import-cycles-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "a.ts"), `import { b } from "./b.ts";\nexport const a = () => b;\n`);
	writeFileSync(join(dir, "b.ts"), `import { a } from "./a.ts";\nexport const b = () => a;\n`);
	writeFileSync(join(dir, "c.ts"), `import type { D } from "./d.ts";\nexport type C = D[];\n`);
	writeFileSync(join(dir, "d.ts"), `import { type C } from "./c.ts";\nexport type { C } from "./c.ts";\nexport type D = { c?: C };\n`);
	assert.deepEqual(findCycles(dir), [{ cycle: ["a.ts", "b.ts"], also: [] }]);
});

test("the web client has no runtime import cycle", () => {
	const cycles = findCycles(web);
	assert.ok(cycles.length === 0, cycleReport(cycles));
});
