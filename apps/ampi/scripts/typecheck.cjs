#!/usr/bin/env node
// Typecheck both projects with tsgo (TypeScript native preview) in parallel.
// `--agree` also runs tsc and fails unless both compilers pass or fail alike
// and report the same error set per project (tsc exits 2 where tsgo exits 1). `test:full` runs `--agree`;
// `npm run typecheck:tsc` is the fallback when tsgo is unavailable or suspect.
const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const projects = ["tsconfig.json", "web/tsconfig.json"];
const packages = { tsgo: ["@typescript/native-preview", "bin/tsgo"], tsc: ["typescript", "bin/tsc"] };
const bin = (compiler) => {
	const [name, file] = packages[compiler];
	return path.join(path.dirname(require.resolve(`${name}/package.json`, { paths: [root] })), file);
};

function check(compiler, project) {
	return new Promise((resolve) => {
		const start = process.hrtime.bigint();
		const child = spawn(process.execPath, [bin(compiler), "-p", project, "--noEmit", "--pretty", "false"], { cwd: root });
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		child.on("close", (status) => resolve({ compiler, project, status, output, seconds: Number(process.hrtime.bigint() - start) / 1e9 }));
	});
}

// Messages may be worded differently; file, position and code identify an error.
const errors = (output) => new Set(output.split("\n").map((line) => line.match(/^(.+\(\d+,\d+\)): error (TS\d+):/)).filter(Boolean).map((m) => `${m[1]} ${m[2]}`));

async function main() {
	const agree = process.argv.includes("--agree");
	const compilers = agree ? ["tsgo", "tsc"] : ["tsgo"];
	const runs = await Promise.all(compilers.flatMap((compiler) => projects.map((project) => check(compiler, project))));
	let failed = false;
	for (const run of runs) {
		if (run.compiler === "tsgo" || run.status !== 0) process.stdout.write(run.output);
		console.log(`[typecheck] ${run.compiler} ${run.project}: exit ${run.status}, ${run.seconds.toFixed(1)}s`);
		failed ||= run.status !== 0;
	}
	if (agree) for (const project of projects) {
		const [fast, ref] = ["tsgo", "tsc"].map((compiler) => runs.find((run) => run.compiler === compiler && run.project === project));
		const a = errors(fast.output), b = errors(ref.output);
		const onlyTsgo = [...a].filter((e) => !b.has(e)), onlyTsc = [...b].filter((e) => !a.has(e));
		if ((fast.status === 0) === (ref.status === 0) && !onlyTsgo.length && !onlyTsc.length) continue;
		console.error(`[typecheck] tsgo and tsc disagree on ${project}: exit ${fast.status} vs ${ref.status}; only tsgo ${JSON.stringify(onlyTsgo)}; only tsc ${JSON.stringify(onlyTsc)}`);
		failed = true;
	}
	process.exit(failed ? 1 : 0);
}
main();
