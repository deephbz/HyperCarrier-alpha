// The one write and read path for a file that a test and a fake CLI share while both run.
// A fake CLI `require`s this file by absolute path; tests use it through pi-fixtures.ts.
// Plain CommonJS, so a fake runs it on any supported Node with no loader warning on its stderr.
const fs = require("node:fs");

let temps = 0;

/**
 * Replaces `file` with `text`. A concurrent reader sees the old or the new whole file, never a truncated one:
 * the text goes to a temp file in the same directory, and a rename puts it in place. The temp name carries the
 * process ID, so two processes never share one.
 */
function replaceFile(file, text) {
	const temp = `${file}.${process.pid}.${++temps}.tmp`;
	fs.writeFileSync(temp, text);
	fs.renameSync(temp, file);
}

/** Appends one JSON record as a single newline-terminated write. */
function appendRecord(file, record) {
	fs.appendFileSync(file, JSON.stringify(record) + "\n");
}

/** The complete records of an `appendRecord` log. A record counts only after its newline is written. */
function readRecords(file) {
	if (!fs.existsSync(file)) return [];
	const text = fs.readFileSync(file, "utf8");
	return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

module.exports = { replaceFile, appendRecord, readRecords };
