#!/usr/bin/env node
// Bans the escapes that hide a wire value's type (docs/wire-boundary.md, rule 3): `as never`, `as unknown as`, and
// `any`, in the files that produce hub → browser values. It reads the syntax tree, so comments and strings never match.
// `npm run typecheck` runs it; `node scripts/lint-casts.cjs` runs it alone.
require("./stdio-sync.cjs");
const { readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [root] }));
const SCOPE = ["src/pi/host.ts", "src/pi/projection.ts", ...readdirSync(path.join(root, "src/pi/views")).filter((f) => f.endsWith(".ts")).map((f) => `src/pi/views/${f}`)];

/** Every banned escape in one source, as `file:line:col what`. */
function scan(file, text) {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const found = [];
	const at = (node, what) => {
		const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
		found.push(`${file}:${line + 1}:${character + 1} ${what}`);
	};
	const visit = (node) => {
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			if (node.type.kind === ts.SyntaxKind.NeverKeyword) at(node, "`as never`");
			const inner = ts.isParenthesizedExpression(node.expression) ? node.expression.expression : node.expression;
			if ((ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) && inner.type.kind === ts.SyntaxKind.UnknownKeyword) at(node, "`as unknown as`");
		}
		if (node.kind === ts.SyntaxKind.AnyKeyword) at(node, "`any`");
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

module.exports = { scan, SCOPE };

if (require.main === module) {
	const start = process.hrtime.bigint();
	const found = SCOPE.flatMap((file) => scan(file, readFileSync(path.join(root, file), "utf8")));
	for (const line of found) console.error(`${line}: declare the wire type in src/shared/protocol.ts instead`);
	console.log(`[lint-casts] ${SCOPE.length} files, ${found.length} escapes, ${(Number(process.hrtime.bigint() - start) / 1e9).toFixed(1)}s`);
	process.exit(found.length ? 1 : 0);
}
