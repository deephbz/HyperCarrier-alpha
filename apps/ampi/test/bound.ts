// Bounds every test file, including a bare `node --test [--test-name-pattern=…] <file>` run that bypasses
// scripts/run-tests.cjs (one such run hung for 68 min). A file still running after AMPI_TEST_FILE_TIMEOUT_MS
// (default 180 s) prints its open handles and exits 1. The timer is unref'd, so it never keeps a file alive.
// Limits: a bare run gets no per-test bound, and processes the file spawned outlive it; the runner adds both.
// Every test file imports this module first; `npm run test:lanes` checks that.
const limit = Number(process.env.AMPI_TEST_FILE_TIMEOUT_MS ?? 180_000);
setTimeout(() => {
	const handles = process.getActiveResourcesInfo().filter((kind) => kind !== "TTYWrap");
	process.stderr.write(`TIMEOUT ${process.argv[1]}: still running after ${limit / 1000} s. A test or an open handle never ended. Open: ${handles.join(", ") || "none"}. Run it through \`npm test -- <file>\`.\n`);
	process.exit(1);
}, limit).unref();
